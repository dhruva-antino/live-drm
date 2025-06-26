const { workerData, parentPort } = require('worker_threads');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const { inputPath, streamKey } = workerData;
const tempDir = path.join(os.tmpdir(), 'streams', streamKey);

// Create temp directory
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Communication helpers
const sendProgress = (progress) => {
  parentPort.postMessage({ type: 'progress', data: progress });
};

const sendSegment = (filePath, resolution) => {
  parentPort.postMessage({ 
    type: 'segment', 
    data: { 
      filePath, 
      key: `${streamKey}/hls/${resolution}/${path.basename(filePath)}`
    }
  });
};

// Resolution profiles
const resolutions = [
  { name: '480p', width: 854, height: 480, bitrate: '1000k' },
  { name: '720p', width: 1280, height: 720, bitrate: '2500k' },
  { name: '1080p', width: 1920, height: 1080, bitrate: '5000k' },
];

// Start transcoding
console.log(`Starting transcoding for: ${streamKey}`);
const startTime = Date.now();

const command = ffmpeg(inputPath)
  .inputOptions([
    '-re',               // Real-time input reading
    '-fflags', 'nobuffer',
    '-rtmp_buffer', '100' 
  ])
  .outputOptions([
    // Audio config (single audio track for all)
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    
    // HLS config
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_playlist_type', 'event',
    
    // Master playlist
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', '"v:0,name:480p v:1,name:720p v:2,name:1080p a:0,name:audio"',
    
    // Segment naming
    '-hls_segment_filename', path.join(tempDir, 'hls', '%v', 'segment_%05d.ts')
  ]);

// Add video filters and mappings
resolutions.forEach((res, i) => {
  command
    .outputOptions([
      `-filter_complex:${i}`,
      `[0:v]scale=w=${res.width}:h=${res.height}:force_original_aspect_ratio=decrease,fps=30[v${i}]`
    ])
    .map(`[v${i}]`)
    .videoCodec('libx264')
    .videoBitrate(res.bitrate)
    .addOption('-preset', 'veryfast')
    .addOption('-g', '60')
    .addOption('-keyint_min', '60')
    .addOption('-sc_threshold', '0')
    .addOption('-profile:v', 'main');
});

// Add audio mapping
command.map('0:a');

// Set output path
command.output(path.join(tempDir, 'hls', 'master.m3u8'));

// Event handlers
command
  .on('start', (cmd) => console.log('FFmpeg command:', cmd))
  .on('progress', (progress) => {
    // Calculate progress percentage (time-based estimation)
    const elapsed = (Date.now() - startTime) / 1000;
    sendProgress(Math.min(100, (elapsed / 60) * 100).toFixed(2));
  })
  .on('stderr', (line) => {
    // Detect segment creation
    const match = line.match(/segment_(\d+)\.ts for stream (\d+)/);
    if (match) {
      const [_, segmentNum, streamIndex] = match;
      const res = resolutions[streamIndex]?.name || 'audio';
      const segPath = path.join(
        tempDir, 
        'hls', 
        streamIndex.toString(), 
        `segment_${segmentNum.padStart(5, '0')}.ts`
      );
      sendSegment(segPath, res);
    }
  })
  .on('end', () => console.log('Transcoding completed'))
  .on('error', (err) => {
    console.error('Transcoding error:', err);
    parentPort.postMessage({ type: 'error', data: err.message });
  })
  .run();

// Handle termination
parentPort.on('message', (msg) => {
  if (msg.type === 'stop') {
    command.kill('SIGINT');
    console.log('Transcoding stopped by request');
  }
});