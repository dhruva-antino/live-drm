import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { spawn } from 'child_process';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import mime from 'mime-types';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';
const execAsync = promisify(exec);

type Resolution = {
  width: number;
  height: number;
  bitrate?: string;
};

type StreamOptions = {
  resolutions?: Resolution[];
};

type Stream = {
  inputUrl: string;
  streamKey: string;
  status: 'created' | 'listening' | 'active' | 'ended';
  outputDir: string;
  process: any;
  playbackUrl: string;
  timings: {
    ffmpegStart: number;
    ffmpegActive: number;
    firstFileUploadStart: number;
    firstFileUploadEnd: number;
    ffmpegExit: number;
  };
};

@Injectable()
export class StreamService implements OnModuleDestroy {
  private activeStreams = new Map<string, Stream>();
  private s3: S3Client;
  private readonly hlsBasePath = './hls_output';
  private readonly logger = new Logger(StreamService.name);
  constructor(private configService: ConfigService) {
    // Create output directory
    if (!fs.existsSync(this.hlsBasePath)) {
      fs.mkdirSync(this.hlsBasePath, { recursive: true });
    }

    // Configure S3 client
    this.s3 = new S3Client({
      region: this.configService.get('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  onModuleDestroy() {
    // this.activeStreams.forEach((_, streamId) => this.stopStream(streamId));
  }

  createHLSStream(inputUrl: string, streamKey: string) {
    const streamId = `hls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputDir = path.join(this.hlsBasePath, streamId);
    fs.mkdirSync(outputDir, { recursive: true });

    this.activeStreams.set(streamId, {
      inputUrl,
      streamKey,
      status: 'created',
      outputDir,
      process: null,
      playbackUrl: '',
      timings: {
        ffmpegStart: 0,
        ffmpegActive: 0,
        firstFileUploadStart: 0,
        firstFileUploadEnd: 0,
        ffmpegExit: 0,
      },
    });
    console.log({ activeSTreams: this.activeStreams });
    return { streamId };
  }

  async startHLSStream(streamId: string, options?: StreamOptions) {
    const stream = this.activeStreams.get(streamId);
    if (!stream) throw new Error('Stream not found');

    stream.timings.ffmpegStart = Date.now();

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-re', 
      '-f',
      'hls',
      '-live_start_index',
      '0',
      '-i',
      stream.inputUrl,
    ];

    if (options?.resolutions && options.resolutions.length > 0) {
      const filterParts = [];
      const varStreamMap = [];
      const mapArgs: string[] = [];
      const videoBitrates: string[] = [];

      options.resolutions.forEach((res, index) => {
        const label = `v${index}`;
        filterParts.push(
          `[0:v]scale=w=${res.width}:h=${res.height}:force_original_aspect_ratio=decrease[${label}]`,
        );
        mapArgs.push('-map', `[${label}]`, '-map', 'a:0?');
        varStreamMap.push(`v:${index},a:${index},name:stream_${res.height}p`);
        videoBitrates.push(
          `-b:v:${index}`,
          res.bitrate || this.defaultBitrate(res.height),
        );
      });

      ffmpegArgs.push(
        '-filter_complex',
        filterParts.join(';'),
        ...mapArgs,
        '-c:v',
        'libx264',
        ...videoBitrates,
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
      );

      options.resolutions.forEach((_, i) => {
        ffmpegArgs.push(`-b:a:${i}`, '128k');
      });

      ffmpegArgs.push(
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_list_size',
        '0',
        '-hls_flags',
        'independent_segments+append_list',
        '-master_pl_name',
        'master.m3u8',
        '-var_stream_map',
        varStreamMap.join(' '),
        '-hls_segment_filename',
        path.join(stream.outputDir, 'stream_%v', 'segment_%03d.ts'),
        path.join(stream.outputDir, 'stream_%v', 'stream.m3u8'),
      );
    } else {
      ffmpegArgs.push(
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_list_size',
        '0',
        '-hls_flags',
        'independent_segments+append_list',
        '-hls_segment_filename',
        path.join(stream.outputDir, 'segment_%03d.ts'),
        path.join(stream.outputDir, 'master.m3u8'),
      );
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    stream.process = ffmpeg;
    stream.status = 'listening';

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Input #0')) {
        stream.status = 'active';
        stream.timings.ffmpegActive = Date.now();
        console.log(
          `[${streamId}] FFmpeg active in: ${stream.timings.ffmpegActive - stream.timings.ffmpegStart}ms`,
        );
      }
      console.log(`[${streamId}] ffmpeg:`, msg.trim());
    });

    ffmpeg.on('close', async (code) => {
      console.log(`[${streamId}] ffmpeg exited with ${code}`);
      stream.status = 'ended';
      stream.timings.ffmpegExit = Date.now();
      console.log(
        `[${streamId}] FFmpeg runtime: ${stream.timings.ffmpegExit - stream.timings.ffmpegStart}ms`,
      );
    });

    const watcher = chokidar.watch(stream.outputDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher.on('add', (filePath) =>
      this.uploadToS3(filePath, stream, streamId),
    );
    watcher.on('change', (filePath) =>
      this.uploadToS3(filePath, stream, streamId),
    );

    const bucket = this.configService.get('AWS_S3_BUCKET');
    const region = this.configService.get('AWS_REGION');
    const s3Prefix = `live-streams/${streamId}`;
    stream.playbackUrl = `https://${bucket}.s3.${region}.amazonaws.com/${s3Prefix}/master.m3u8`;

    return {
      message: 'HLS stream processing started',
      playbackUrl: stream.playbackUrl,
    };
  }

  async startHLSStreamV1(streamId: string, options?: StreamOptions) {
    const stream = this.activeStreams.get(streamId);
    if (!stream) throw new Error('Stream not found');

    stream.timings.ffmpegStart = Date.now();

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-re', 
      '-f', 'dash',
      '-i', stream.inputUrl,
      '-ignore_io_errors', '1',
      '-fflags', '+genpts'
    ];

    if (options?.resolutions && options.resolutions.length > 0) {
      const filterParts = [];
      const varStreamMap = [];
      const mapArgs: string[] = [];
      const videoBitrates: string[] = [];

      options.resolutions.forEach((res, index) => {
        const label = `v${index}`;
        filterParts.push(
          `[0:v]scale=w=${res.width}:h=${res.height}:force_original_aspect_ratio=decrease[${label}]`,
        );
        mapArgs.push('-map', `[${label}]`, '-map', 'a:0?');
        varStreamMap.push(`v:${index},a:${index},name:stream_${res.height}p`);
        videoBitrates.push(
          `-b:v:${index}`,
          res.bitrate || this.defaultBitrate(res.height),
        );
      });

      ffmpegArgs.push(
        '-filter_complex',
        filterParts.join(';'),
        ...mapArgs,
        '-c:v',
        'libx264',
        ...videoBitrates,
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
      );

      options.resolutions.forEach((_, i) => {
        ffmpegArgs.push(`-b:a:${i}`, '128k');
      });

      ffmpegArgs.push(
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_list_size',
        '0',
        '-hls_flags',
        'independent_segments+append_list',
        '-master_pl_name',
        'master.m3u8',
        '-var_stream_map',
        varStreamMap.join(' '),
        '-hls_segment_filename',
        path.join(stream.outputDir, 'stream_%v', 'segment_%03d.ts'),
        path.join(stream.outputDir, 'stream_%v', 'stream.m3u8'),
      );
    } else {
      ffmpegArgs.push(
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_list_size',
        '0',
        '-hls_flags',
        'independent_segments+append_list',
        '-hls_segment_filename',
        path.join(stream.outputDir, 'segment_%03d.ts'),
        path.join(stream.outputDir, 'master.m3u8'),
      );
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    stream.process = ffmpeg;
    stream.status = 'listening';

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Input #0')) {
        stream.status = 'active';
        stream.timings.ffmpegActive = Date.now();
        console.log(
          `[${streamId}] FFmpeg active in: ${stream.timings.ffmpegActive - stream.timings.ffmpegStart}ms`,
        );
      }
      console.log(`[${streamId}] ffmpeg:`, msg.trim());
    });

    ffmpeg.on('close', async (code) => {
      console.log(`[${streamId}] ffmpeg exited with ${code}`);
      stream.status = 'ended';
      stream.timings.ffmpegExit = Date.now();
      console.log(
        `[${streamId}] FFmpeg runtime: ${stream.timings.ffmpegExit - stream.timings.ffmpegStart}ms`,
      );
    });

    const watcher = chokidar.watch(stream.outputDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher.on('add', (filePath) =>
    {
      console.log({filePath})
      this.uploadToS3(filePath, stream, streamId)
    }
    );
    watcher.on('change', (filePath) =>
      this.uploadToS3(filePath, stream, streamId),
    );

    const bucket = this.configService.get('AWS_S3_BUCKET');
    const region = this.configService.get('AWS_REGION');
    const s3Prefix = `live-streams/${streamId}`;
    stream.playbackUrl = `https://${bucket}.s3.${region}.amazonaws.com/${s3Prefix}/master.m3u8`;

    return {
      message: 'HLS stream processing started',
      playbackUrl: stream.playbackUrl,
    };
  }

   async convertAndUploadHlsToDash(hlsUrl: string, streamId: string): Promise<string> {
    if (!streamId) {
      throw new Error('streamId is required');
    }

    // Create temp directory with streamId
    const tempDir = path.join(os.tmpdir(), `dash-${streamId}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    
    const outputPath = path.join(tempDir, 'manifest.mpd');
    this.logger.log(`Temp directory created: ${tempDir}`);

    const command = `ffmpeg -i "${hlsUrl}" \
      -c copy \
      -tag:v avc1 \
      -tag:a mp4a \
      -bsf:a aac_adtstoasc \
      -f dash \
      -dash_segment_type mp4 \
      -seg_duration 4 \
      -frag_duration 4 \
      -window_size 10 \
      -streaming 0 \
      -ignore_io_errors 1 \
      -use_template 1 \
      -use_timeline 1 \
      -init_seg_name 'init-$RepresentationID$.$ext$' \
      -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.$ext$' \
      -adaptation_sets "id=0,streams=v id=1,streams=a" \
      "${outputPath}"`;

    this.logger.log(`Executing FFmpeg command: ${command}`);

    try {
      // Execute FFmpeg and log output
      const { stdout, stderr } = await execAsync(command);
      this.logger.debug(`FFmpeg stdout: ${stdout}`);
      this.logger.debug(`FFmpeg stderr: ${stderr}`);

      // Verify files were created
      const files = fs.readdirSync(tempDir);
      if (files.length === 0) {
        throw new Error('No files generated by FFmpeg');
      }
      this.logger.log(`Generated ${files.length} files in temp directory`);

      // Upload to S3
      await this.uploadDirectoryToS3(tempDir, streamId);
      
      return this.getManifestUrl(streamId);
    } catch (error) {
      this.logger.error(`Conversion failed: ${error.message}`, error.stack);
      // Debug: List temp directory contents on error
      try {
        const files = fs.readdirSync(tempDir);
        this.logger.error(`Temp directory contents: ${files.join(', ')}`);
      } catch (e) {
        this.logger.error(`Error reading temp directory: ${e.message}`);
      }
      throw error;
    } finally {
      // Cleanup temp directory
      try {
        // fs.rmSync(tempDir, { recursive: true, force: true });
        this.logger.log(`Cleaned up temp directory: ${tempDir}`);
      } catch (cleanupError) {
        this.logger.warn(`Temp cleanup failed: ${cleanupError.message}`);
      }
    }
  }

  private getManifestUrl(streamId: string): string {
    const bucket = this.configService.get('AWS_S3_BUCKET');
    const region = this.configService.get('AWS_REGION');
    return `https://${bucket}.s3.${region}.amazonaws.com/live-streams/${streamId}/manifest.mpd`;
  }

    private async uploadDirectoryToS3(directory: string, streamId: string) {
    const files = this.getFilesRecursive(directory);
    const bucket = this.configService.get('AWS_S3_BUCKET');
    const s3Prefix = `live-streams/${streamId}`;

    await Promise.all(files.map(async (filePath) => {
      if (!this.isDashFile(filePath)) return;
      
      const contentType = this.getContentType(filePath);
      const relativePath = path.relative(directory, filePath);
      const key = path.join(s3Prefix, relativePath).replace(/\\/g, '/');
      const fileStream = fs.createReadStream(filePath);

      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            ContentType: contentType,
            ACL: 'public-read',
          })
        );
        console.log(`Uploaded: ${key}`);
      } catch (err) {
        console.error(`Upload failed for ${key}:`, err);
      }
    }));
  }

  private getFilesRecursive(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? this.getFilesRecursive(fullPath) : fullPath;
    });
  }

  private isDashFile(filePath: string): boolean {
    return ['.mpd', '.m4s', '.mp4'].includes(path.extname(filePath));
  }

  private getContentType(filePath: string): string {
    return filePath.endsWith('.mpd')
      ? 'application/dash+xml'
      : mime.lookup(filePath) || 'application/octet-stream';
  }

  private async uploadToS3(filePath: string, stream: Stream, streamId: string) {

    try {
      let contentType: string;
      let key: string;
      const bucket = this.configService.get('AWS_S3_BUCKET');
      const s3Prefix = `live-streams/${streamId}`;

      // Determine content type
      if (filePath.endsWith('.mpd')) {
        contentType = 'application/dash+xml';
      } else {
        contentType = mime.lookup(filePath) || 'application/octet-stream';
      }

      // Generate S3 key
      key = path
        .join(s3Prefix, path.relative(stream.outputDir, filePath))
        .replace(/\\/g, '/');

      // For manifest files, fix relative paths
      if (filePath.endsWith('.mpd')) {
        let content = await fs.promises.readFile(filePath, 'utf8');

        // Fix representation paths
        content = content.replace(
          /<BaseURL>([^<]+)<\/BaseURL>/g,
          (match, baseUrl) => {
            // If baseUrl contains a representation ID, add folder prefix
            if (baseUrl.includes('$RepresentationID$')) {
              const folderName = baseUrl.replace('$RepresentationID$', '');
              return `<BaseURL>${folderName}/${baseUrl}</BaseURL>`;
            }
            return match;
          },
        );

        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: content,
            ContentType: contentType,
            ACL: 'public-read',
          }),
        );
      } else {
        const fileStream = fs.createReadStream(filePath);
        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            ContentType: contentType,
            ACL: 'public-read',
          }),
        );
      }

      // Timing logic
      if (!stream.timings.firstFileUploadStart) {
        stream.timings.firstFileUploadStart = Date.now();
      }
      if (!stream.timings.firstFileUploadEnd) {
        stream.timings.firstFileUploadEnd = Date.now();
        console.log(
          `[${streamId}] First file upload time: ${stream.timings.firstFileUploadEnd - stream.timings.ffmpegStart}ms`,
        );
      }
      console.log(`[S3] Uploaded ${key}`);
    } catch (err) {
      console.error(`[S3] Upload failed for ${filePath}`, err);
    }
  }
  private defaultBitrate(height: number): string {
    if (height >= 1080) return '4500k';
    if (height >= 720) return '2500k';
    if (height >= 480) return '1000k';
    return '500k';
  }
}
