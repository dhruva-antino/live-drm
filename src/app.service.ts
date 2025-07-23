import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import path, { join } from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import * as mime from 'mime-types';
import * as portfinder from 'portfinder';
import { v4 as uuidv4 } from 'uuid';
import { HttpService } from '@nestjs/axios';
import { getRootDirectoryPath } from './utils';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { lastValueFrom } from 'rxjs';
import axios from 'axios';
import { glob } from 'glob';

// Axinom DRM Configuration
const WIDEVINE_SIGNING_KEY =
  '5625855D2DED6DCE228F4C5C79778A0B3AA796A015DC17596DFE7A82CC0842F1';
const WIDEVINE_SIGNING_IV = 'ED612526E30EF654002D14FB7AD1AB55';
const WIDEVINE_PROVIDER_NAME = 'f0c70eec-e9bf-43c8-92eb-778040183320';
const KEY_SERVER_URL =
  'https://key-server-management.axprod.net/api/WidevineProtectionInfo';

interface StreamTimings {
  ffmpegStart: number;
  ffmpegActive: number;
  packagerStart: number;
  packagerActive: number;
  firstFileUploadStart: number;
  firstFileUploadEnd: number;
  ffmpegExit: number;
  packagerExit: number;
}
interface ResolutionOption {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
}

export const RES_CONFIG: Record<
  string,
  {
    width: number;
    height: number;
    videoBitrate: string;
    audioBitrate: string;
  }
> = {
  '2160p': {
    width: 3840,
    height: 2160,
    videoBitrate: '8000k',
    audioBitrate: '256k',
  },
  '1440p': {
    width: 2560,
    height: 1440,
    videoBitrate: '6000k',
    audioBitrate: '192k',
  },
  '1080p': {
    width: 1920,
    height: 1080,
    videoBitrate: '5000k',
    audioBitrate: '192k',
  },
  '720p': {
    width: 1280,
    height: 720,
    videoBitrate: '2800k',
    audioBitrate: '128k',
  },
  '480p': {
    width: 854,
    height: 480,
    videoBitrate: '1400k',
    audioBitrate: '96k',
  },
  '360p': {
    width: 640,
    height: 360,
    videoBitrate: '800k',
    audioBitrate: '96k',
  },
  '240p': {
    width: 426,
    height: 240,
    videoBitrate: '400k',
    audioBitrate: '64k',
  },
};

export interface StreamOptions {
  resolutions?: { width: number; height: number; bitrate?: string }[];
  youtubeStreamKey?: string;
  isDRM?: boolean;
  signingKeyAsHex?: string;
  signingIvAsHex?: string;
  signer?: string;
  keyServerUrl?: string;
}

enum EncryptionSchemes {
  CBCS = 'CBCS',
  CENC = 'CENC',
}

enum DRM_Type {
  WIDEVINE = 'WIDEVINE',
  PLAYREADY = 'PLAYREADY',
  FAIRPLAY = 'FAIRPLAY',
}

interface KeyServerResponse {
  tracks: {
    key_id: string;
    key: string;
    iv: string;
    skd_uri: string;
    pssh: {
      drm_type: DRM_Type;
      data: string;
    }[];
  }[];
}
export type ResolutionOutput = {
  name: string;
  width: number;
  height: number;
  file: string;
  videoBitrate: string;
  audioBitrate: string;
};

interface Stream {
  id: string;
  port: number;
  streamKey: string;
  outputDir: string;
  status: string;
  process?: any;
  packagerProcesses?: Map<string, any>;
  timings: any;
  playbackUrl?: string;
}

export interface ActiveStream {
  port?: number;
  streamKey?: string;
  status?: string;
  process?: any;
  outputDir?: string;
  playbackUrl?: string;
  streamId?: string;
  rtmpUrl?: string;
  lastActivity?: number;
  timings?: {
    ffmpegStart: number;
    ffmpegActive: number;
    firstFileUploadStart: number;
    firstFileUploadEnd: number;
    ffmpegExit: number;
    packagerStart?: number;
    packagerActive?: number;
    packagerExit?: number;
  };
  packagerStarted?: boolean; // New property
  packagerProcess?: ChildProcess; // New property
}

// interface Stream {
//   id: string;
//   port: number;
//   streamKey: string;
//   status: 'created' | 'listening' | 'active' | 'ended' | 'error';
//   process: any;
//   youtubeUrl?: string;
// }

interface Resolution {
  width: number;
  height: number;
  bitrate?: string;
}
@Injectable()
export class AppService {
  private ffmpegProcess: any;
  private readonly httpService: HttpService;
  private activeStreams: Map<string, ActiveStream> = new Map();
  private readonly logger = new Logger(AppService.name);
  private hlsBasePath = path.join(process.cwd(), 'hls');
  private PACKAGER_PATH: string;

  private readonly shakaPackagerPath = join(
    getRootDirectoryPath(),
    'scripts',
    'packager-linux-x64',
  );
  private s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  private readonly hlsOutputDir =
    process.env.HLS_OUTPUT_DIR || path.join(process.cwd(), 'hls');
  // private streams = new Map<string, Stream>();
  private streams = new Map<string, any>();

  private readonly publicIp = process.env.SERVER_PUBLIC_IP || 'your-server-ip';
  private readonly rtmpBasePath = '/live';
  constructor() {
    // Ensure HLS directory exists
    if (!fs.existsSync(this.hlsBasePath)) {
      fs.mkdirSync(this.hlsBasePath, { recursive: true });
    }
    this.PACKAGER_PATH = this.getPackagerPath();
    console.log(`Using packager at: ${this.PACKAGER_PATH}`);
  }

  createStreamSRT(port: number, streamKey: string): any {
    const streamId = `stream-${Date.now()}-${port}`;
    const outputDir = path.join(this.hlsBasePath, streamId);

    fs.mkdirSync(outputDir, { recursive: true });

    this.activeStreams.set(streamId, {
      port,
      streamKey,
      status: 'created',
      process: null,
      outputDir,
      lastActivity: Date.now(),
      streamId,
      playbackUrl: '',
    });

    return {
      streamId,
      playbackUrl: '',
      rtmpUrl: `rtmp://0.0.0.0:1935/live/${streamKey}`,
      // srtUrl: `srt://0.0.0.0:${port}?streamid=#!::r=${streamKey}`,
      srtUrl: `srt://0.0.0.0:${port}`,
    };
  }

  async startListenerSRT(streamId: string, options?: StreamOptions) {
    const stream = this.activeStreams.get(streamId);
    // if (!stream || stream.status !== 'created')
    //   return 'Stream not found or already started';
    stream.timings = {
      ffmpegStart: Date.now(),
      ffmpegActive: 0,
      firstFileUploadStart: 0,
      firstFileUploadEnd: 0,
      ffmpegExit: 0,
    };
    let firstFileUploaded = false;
    const masterPlaylistPath = path.join(stream.outputDir, 'master.m3u8');

    // const srtUrl = `srt://563fg0wz-3333.inc1.devtunnels.ms:9000`;
    // const srtUrl = `srt://06d7721f4128.ngrok-free.app:9000?mode=listener&whitelist=0.0.0.0/0`;
    // const srtUrl = `srt://0.0.0.0:8000?mode=listener`;
    const srtUrl = `srt://domeproductions-vngdkppdwm.dynamic-m.com:11383`;

    const outputPath = path.join(stream.outputDir, 'master.m3u8');
    console.time('Time starts for ffmpeg ------>');
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'debug',
      '-protocol_whitelist',
      'file,crypto,udp,rtp,tcp,srt,http,https,tls',
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '2M',
      '-probesize',
      '2M',
      '-i',
      srtUrl,
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
        '-force_key_frames',
        'expr:gte(t,n_forced*2)', // Keyframe every 4 seconds
        '-g',
        '48', // GOP size: 12 * segment duration (4s) * FPS (assume 12 fps) or adjust accordingly
        '-keyint_min',
        '48',
        '-sc_threshold',
        '0',
      );

      options.resolutions.forEach((_, i) => {
        ffmpegArgs.push(`-b:a:${i}`, '128k');
      });

      ffmpegArgs.push(
        '-force_key_frames',
        'expr:gte(t,n_forced*2)', // Force keyframes every 4 seconds
        '-sc_threshold',
        '0',
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
        '-force_key_frames',
        'expr:gte(t,n_forced*4)', // Force keyframes every 4 seconds
        '-sc_threshold',
        '0',
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
        '-force_key_frames',
        'expr:gte(t,n_forced*4)', // Keyframe every 4 seconds
        '-g',
        '48', // GOP size: 12 * segment duration (4s) * FPS (assume 12 fps) or adjust accordingly
        '-keyint_min',
        '48',
        '-sc_threshold',
        '0',
        '-hls_flags',
        'independent_segments+append_list',
        '-hls_segment_filename',
        path.join(stream.outputDir, 'segment_%03d.ts'),
        outputPath,
      );
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    stream.process = ffmpeg;
    stream.status = 'listening';
    const startTime = Date.now();
    console.log({ startTime });
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      // console.log({ msg });
      if (msg.includes('Input #0')) {
        stream.status = 'active';
        stream.timings.ffmpegActive = Date.now();
        console.log(
          `[${streamId}] FFmpeg active in: ${stream.timings.ffmpegActive - stream.timings.ffmpegStart}ms`,
        );
      }
      // console.log(`[${streamId}] ffmpeg:`, msg.trim());
    });

    ffmpeg.on('close', async (code) => {
      console.log(`[${streamId}] ffmpeg exited with ${code}`);
      stream.status = 'ended';
      stream.timings.ffmpegExit = Date.now();
      console.log(
        `[${streamId}] FFmpeg runtime: ${stream.timings.ffmpegExit - stream.timings.ffmpegStart}ms`,
      );
    });

    ffmpeg.on('error', (err) => {
      console.error(`[${streamId}] FFmpeg process error:`, err);
      stream.status = 'error';
      stream.timings.ffmpegExit = Date.now();
    });

    const bucket = process.env.AWS_S3_BUCKET!;
    const s3Prefix = `live-streams/${streamId}`;
    const uploadToS3 = async (filePath: string) => {
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.m3u8')) return;
      try {
        const fileStream = fs.createReadStream(filePath);
        const contentType = mime.lookup(filePath) || 'application/octet-stream';
        const key = path
          .join(s3Prefix, path.relative(stream.outputDir, filePath))
          .replace(/\\/g, '/');

        if (!firstFileUploaded) {
          stream.timings.firstFileUploadStart = Date.now();
          firstFileUploaded = true;
        }
        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            ContentType: contentType,
            ACL: 'public-read',
          }),
        );
        if (!stream.timings.firstFileUploadEnd) {
          stream.timings.firstFileUploadEnd = Date.now();
          console.log(
            `[${streamId}] First file upload time: ${stream.timings.firstFileUploadEnd - stream.timings.ffmpegStart}ms`,
          );
        }
        console.log(`[S3] Uploaded ${key}`);
        console.timeEnd('Time starts for ffmpeg ------>');
      } catch (err) {
        console.error(`[S3] Upload failed for ${filePath}`, err);
      }
    };

    const watcher = chokidar.watch(stream.outputDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });
    console.time('Time starts for S3 ------>');

    watcher.on('add', uploadToS3);
    watcher.on('change', uploadToS3);
    console.timeEnd('Time starts for S3 ------>');

    stream.playbackUrl = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Prefix}/master.m3u8`;

    return {
      message: `Live stream started`,
      s3PlaybackUrl: stream.playbackUrl,
    };
  }

  private getPackagerPath(): string {
    const possiblePaths = [
      '/usr/local/bin/packager', // Homebrew default (Intel)
      '/opt/homebrew/bin/packager', // Homebrew default (Apple Silicon)
      path.resolve(__dirname, '../scripts/packager-osx-x64'), // Custom location
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        try {
          fs.chmodSync(p, 0o755); // Ensure executable
          return p;
        } catch (e) {
          console.warn(`Could not set permissions for ${p}:`, e);
        }
      }
    }

    return 'packager'; // Fallback to PATH
  }

  async startListenerSRTWithDRM(streamId: string, options?: StreamOptions) {
    const stream = this.activeStreams.get(streamId);
    if (!stream || stream.status !== 'created') {
      return 'Stream not found or already started';
    }

    // Create output directory
    if (!fs.existsSync(stream.outputDir)) {
      fs.mkdirSync(stream.outputDir, { recursive: true });
    }

    // Setup timings
    // stream.timings = { ffmpegStart: Date.now() };

    const srtUrl = `srt://0.0.0.0:${stream.port}?mode=listener&streamid=#!::r=${stream.streamKey}`;
    console.log(`Starting SRT listener at ${srtUrl}`);

    // Prepare resolutions
    const resolutions = options?.resolutions || [
      { width: 1280, height: 720, bitrate: '2500k' },
      { width: 854, height: 480, bitrate: '1200k' },
      { width: 640, height: 360, bitrate: '700k' },
    ];

    // Fixed FFmpeg command for HLS with TS segments
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'verbose', // More detailed logging
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '100M',
      '-probesize',
      '100M',
      '-i',
      srtUrl,
    ];

    // Build filter complex
    const filterComplex = [];
    const mapArgs = [];

    // 1. Split video into multiple streams
    filterComplex.push(
      `[0:v]split=${resolutions.length}${resolutions.map((_, i) => `[v${i}in]`).join('')}`,
    );

    // 2. Scale each stream
    resolutions.forEach((res, i) => {
      filterComplex.push(
        `[v${i}in]scale=w=${res.width}:h=${res.height}:force_original_aspect_ratio=decrease[v${i}out]`,
      );
      mapArgs.push('-map', `[v${i}out]`);
    });

    ffmpegArgs.push('-filter_complex', filterComplex.join(';'));

    // Add video encoding params
    resolutions.forEach((res, i) => {
      ffmpegArgs.push(
        `-c:v:${i}`,
        'libx264',
        `-b:v:${i}`,
        res.bitrate,
        `-preset`,
        'veryfast',
        `-g`,
        '48',
        `-keyint_min`,
        '48',
        `-sc_threshold`,
        '0',
      );
    });

    // Audio handling (make it optional)
    ffmpegArgs.push(
      '-map',
      '0:a?', // Optional audio
      '-c:a',
      'aac',
      '-b:a',
      '128k',
    );

    // HLS output parameters
    ffmpegArgs.push(
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '10',
      '-hls_flags',
      'independent_segments+delete_segments',
      '-var_stream_map',
      resolutions
        .map(
          (_, i) =>
            `v:${i}${resolutions.length > 1 ? `,a:${i}` : ''},name:${resolutions[i].height}p`,
        )
        .join(' '),
      '-master_pl_name',
      'master_unencrypted.m3u8',
      path.join(stream.outputDir, 'stream_%v.m3u8'),
    );

    console.log('FFmpeg command:', 'ffmpeg ' + ffmpegArgs.join(' '));
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    stream.process = ffmpeg;
    stream.status = 'listening';

    // FFmpeg logging
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      console.log(`[${streamId}] ffmpeg:`, msg.trim());

      // Detect stream start
      // if (msg.includes('Input #0') && !stream.timings.ffmpegActive) {
      //   stream.timings.ffmpegActive = Date.now();
      //   console.log(
      //     `FFmpeg active in: ${stream.timings.ffmpegActive - stream.timings.ffmpegStart}ms`,
      //   );
      // }

      // Detect master playlist creation
      if (msg.includes('master_unencrypted.m3u8') && !stream.packagerStarted) {
        stream.packagerStarted = true;
        setTimeout(() => {
          this.startPackager(stream, streamId, resolutions.length);
        }, 3000);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[${streamId}] FFmpeg error:`, err);
    });

    ffmpeg.on('close', (code) => {
      console.log(`[${streamId}] FFmpeg exited with code ${code}`);
      if (stream.packagerProcess) stream.packagerProcess.kill();
    });

    // File watcher setup
    const bucket = process.env.AWS_S3_BUCKET!;
    const s3Prefix = `live-streams/${streamId}`;

    const uploadToS3 = async (filePath: string) => {
      if (!filePath.endsWith('.m3u8') && !filePath.endsWith('.ts')) return;

      try {
        const key = path
          .join(s3Prefix, path.relative(stream.outputDir, filePath))
          .replace(/\\/g, '/');
        const contentType = filePath.endsWith('.m3u8')
          ? 'application/x-mpegURL'
          : 'video/MP2T';

        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fs.createReadStream(filePath),
            ContentType: contentType,
            ACL: 'public-read',
          }),
        );
      } catch (err) {
        console.error(`Upload failed: ${filePath}`, err);
      }
    };

    const watcher = chokidar.watch(stream.outputDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 99,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });

    watcher.on('add', uploadToS3);
    watcher.on('change', uploadToS3);

    stream.playbackUrl = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Prefix}/master.m3u8`;
    return {
      message: `Live stream started with DRM protection`,
      playbackUrl: stream.playbackUrl,
    };
  }

  async startPackager(stream: any, streamId: string, variantCount: number) {
    console.log('Starting Shaka Packager for encryption...');

    const KEY_SERVER_URL = process.env.WIDEVINE_KEY_SERVER_URL!;
    const WIDEVINE_PROVIDER = process.env.WIDEVINE_PROVIDER!;
    const WIDEVINE_SIGNING_KEY = process.env.WIDEVINE_SIGNING_KEY!;
    const WIDEVINE_SIGNING_IV = process.env.WIDEVINE_SIGNING_IV!;

    const packagerArgs = [
      '--enable_widevine_encryption',
      `--key_server_url="${KEY_SERVER_URL}"`,
      `--content_id="${streamId}"`,
      `--signer="${WIDEVINE_PROVIDER}"`,
      `--aes_signing_key="${WIDEVINE_SIGNING_KEY}"`,
      `--aes_signing_iv="${WIDEVINE_SIGNING_IV}"`,
      '--protection_scheme=cbcs',
      '--hls_key_uri="skd://' + streamId + '"',
      `--hls_master_playlist_output="${path.join(stream.outputDir, 'master.m3u8')}"`,
      '--hls_playlist_type',
      'LIVE',
      '--hls_base_url',
      `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/live-streams/${streamId}/`,
      '--segment_duration',
      '4',
      '--fragment_duration',
      '4',
      '--time_shift_buffer_depth',
      '30',
      '--preserved_segments_outside_live_window',
      '10',
      '--default_language=eng',
      '-v',
      '2', // Verbose logging
    ];

    // Add each variant
    for (let i = 0; i < variantCount; i++) {
      const playlistPath = path.join(stream.outputDir, `stream_${i}.m3u8`);
      packagerArgs.push(
        `in=${playlistPath},format=hls,playlist_name=enc_stream_${i}.m3u8,iframe_playlist_name=enc_iframe_${i}.m3u8`,
      );
    }

    console.log('Packager command:', 'packager ' + packagerArgs.join(' '));

    try {
      const packager = spawn('packager', packagerArgs, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      stream.packagerProcess = packager;

      packager.stdout.on('data', (data) => {
        console.log(`[Packager] ${data.toString().trim()}`);
      });

      packager.stderr.on('data', (data) => {
        console.error(`[Packager ERROR] ${data.toString().trim()}`);
      });

      packager.on('close', (code) => {
        console.log(`Packager exited with code ${code}`);
      });
    } catch (err) {
      console.error('Failed to start packager:', err);
    }
  }

  private setupS3Uploader(streamId: string, outputDir: string) {
    const bucket = process.env.AWS_S3_BUCKET;
    const region = process.env.AWS_REGION;
    const s3Prefix = `live-streams/${streamId}`;

    const watcher = chokidar.watch(outputDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const uploadFileToS3 = async (filePath: string) => {
      try {
        const fileStream = fs.createReadStream(filePath);
        const contentType = mime.lookup(filePath) || 'application/octet-stream';
        const key = path
          .join(s3Prefix, path.relative(outputDir, filePath))
          .replace(/\\/g, '/');

        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            ContentType: contentType,
            CacheControl: filePath.endsWith('.m3u8')
              ? 'no-store'
              : 'public, max-age=31536000',
            ACL: 'public-read',
          }),
        );

        console.log(`[S3] Uploaded ${key}`);
      } catch (err) {
        console.error(`[S3] Upload failed for ${filePath}`, err);
      }
    };

    watcher.on('add', async (filePath) => {
      if (filePath.endsWith('.ts') || filePath.endsWith('.m3u8')) {
        await uploadFileToS3(filePath);
      }
    });

    watcher.on('change', async (filePath) => {
      if (filePath.endsWith('.m3u8')) {
        await uploadFileToS3(filePath);
      }
    });
  }

  async startSimpleStreamOld(youtubeKey: string) {
    if (this.ffmpegProcess) {
      return { error: 'Stream is already running' };
    }

    const port = await portfinder.getPortPromise({
      startPort: 1935,
      stopPort: 2000,
    });

    const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';
    const youtubeUrl = `${rtmpUrl}/${youtubeKey}`;
    const localRtmp = `rtmp://0.0.0.0:${port}/live/stream`;

    const ffmpegArgs = [
      '-listen',
      '1',
      '-i',
      localRtmp,
      '-c',
      'copy',
      '-f',
      'flv',
      youtubeUrl,
    ];

    console.log('🚀 Starting FFmpeg with command:');
    console.log('ffmpeg', ffmpegArgs.join(' '));

    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      console.log('FFmpeg:', msg.trim());

      if (msg.includes('rtmp://a.rtmp.youtube.com')) {
        console.log('🔥 Connected to YouTube!');
      }
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      this.ffmpegProcess = null;
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('FFmpeg error:', err.message);
      this.ffmpegProcess = null;
    });

    return {
      message: 'RTMP listener started',
      push_url: `rtmp://localhost:${port}/live/stream`,
    };
  }

  async startSimpleStream(youtubeKey: string) {
    if (this.ffmpegProcess) {
      return { error: 'Stream is already running' };
    }

    const port = await portfinder.getPortPromise({
      startPort: 1935,
      stopPort: 2000,
    });

    // const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';
    // const youtubeUrl = `${rtmpUrl}/${youtubeKey}`;
    const localRtmp = `rtmp://0.0.0.0:${port}/live/stream`;

    // Create unique HLS output directory for this stream
    const streamId = `stream-${Date.now()}`;
    const hlsPath = path.join(this.hlsOutputDir, streamId);
    fs.mkdirSync(hlsPath, { recursive: true });

    const ffmpegArgs = [
      '-listen',
      '1',
      '-i',
      localRtmp,

      // YouTube output (direct passthrough)
      // '-c:v',
      // 'copy',
      // '-c:a',
      // 'copy',
      // '-f',
      // 'flv',
      // youtubeUrl,

      // HLS output
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-g',
      '60',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-f',
      'hls',

      '-hls_time',
      '4',
      '-hls_list_size',
      '0',
      '-hls_flags',
      'append_list+independent_segments',
      '-hls_segment_filename',
      path.join(hlsPath, 'segment_%03d.ts'),
      path.join(hlsPath, 'stream.m3u8'),
    ];
    console.log({ hlsPath });
    console.log('🚀 Starting FFmpeg with command:');
    console.log('ffmpeg', ffmpegArgs.join(' '));

    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      console.log('FFmpeg:', msg.trim());

      if (msg.includes('.ts')) console.log('HLS segment created');
      if (msg.includes('.m3u8')) console.log('HLS playlist updated');
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      this.ffmpegProcess = null;
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('FFmpeg error:', err.message);
      this.ffmpegProcess = null;
    });

    return {
      message: 'RTMP listener started',
      push_url: localRtmp,
      hls_url: `${process.env.BASE_URL || 'http://localhost:3000'}/hls/${streamId}/stream.m3u8`,
    };
  }

  async startRtmpToHlsS3(options?: StreamOptions) {
    const streamId = `stream-${Date.now()}`;
    const outputDir = path.join(this.hlsOutputDir, streamId);
    fs.mkdirSync(outputDir, { recursive: true });
    const port = await portfinder.getPortPromise({
      startPort: 1935,
      stopPort: 2000,
    });

    const localRtmp = `rtmp://0.0.0.0:${port}/live/stream`;

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '10M',
      '-probesize',
      '10M',
      '-listen',
      '1',
      '-i',
      localRtmp,
    ];

    if (options?.resolutions?.length) {
      const filterParts: string[] = [];
      const varStreamMap: string[] = [];
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
        path.join(outputDir, 'stream_%v', 'segment_%03d.ts'),
        path.join(outputDir, 'stream_%v', 'stream.m3u8'),
      );
    } else {
      const outputPath = path.join(outputDir, 'master.m3u8');
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
        path.join(outputDir, 'segment_%03d.ts'),
        outputPath,
      );
    }

    console.log('🚀 Starting FFmpeg with command:');
    console.log('ffmpeg', ffmpegArgs.join(' '));

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    let firstFileUploaded = false;
    ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg.includes('Input #0')) {
        console.log(`[${streamId}] FFmpeg active in: ${new Date()}`);
      }
      console.log(`[${streamId}] FFmpeg:`, msg);
    });

    ffmpegProcess.on('close', (code) => {
      console.log(`[${streamId}] FFmpeg exited with ${code}`);
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`[${streamId}] FFmpeg error:`, err.message);
    });

    // S3 Upload Setup
    const bucket = process.env.AWS_S3_BUCKET!;
    const s3Prefix = `live-streams/${streamId}`;

    const uploadToS3 = async (filePath: string) => {
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.m3u8')) return;

      try {
        const fileStream = fs.createReadStream(filePath);
        const contentType = mime.lookup(filePath) || 'application/octet-stream';
        const key = path
          .join(s3Prefix, path.relative(outputDir, filePath))
          .replace(/\\/g, '/');

        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            ContentType: contentType,
            ACL: 'public-read',
          }),
        );
        console.log(`[${streamId}] Uploaded: ${key}`);
      } catch (err) {
        console.error(`[${streamId}] Upload failed:`, filePath, err);
      }
    };

    const watcher = chokidar.watch(outputDir, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher.on('add', uploadToS3);
    watcher.on('change', uploadToS3);
    return {
      message: 'RTMP listener started',
      push_url: `rtmp://localhost:${port}/live/stream`,
      playback_url: `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Prefix}/master.m3u8`,
    };
  }

  private defaultBitrate(height: number): string {
    if (height <= 360) return '800k';
    if (height <= 480) return '1400k';
    if (height <= 720) return '2800k';
    if (height <= 1080) return '5000k';
    return '8000k';
  }

  stopListener(streamId: string): string {
    const stream = this.activeStreams.get(streamId);

    if (stream?.process) {
      stream.process.kill('SIGINT');
      stream.status = 'stopped';
      return `Stream ${streamId} stopped`;
    }

    return `Stream ${streamId} not active`;
  }

  getStatus(streamId: string): string {
    const stream = this.activeStreams.get(streamId);
    return stream ? `Status: ${stream.status}` : 'Stream not found';
  }

  getAllActiveStreams() {
    const streamsArray = Array.from(this.activeStreams.values());
    console.log({
      streams: streamsArray.forEach((e) =>
        console.log({ streamTimming: e.timings }),
      ),
    });
    return streamsArray;
  }

  async createStreamRTMP(): Promise<{ streamId: string; rtmpUrl: string }> {
    const port = await portfinder.getPortPromise({
      startPort: 1935,
      stopPort: 3000,
    });

    const streamKey = uuidv4();
    const streamId = `strm-${Date.now()}-${port}`;
    const hlsPath = path.join(this.hlsOutputDir, streamId);

    this.streams.set(streamId, {
      id: streamId,
      port,
      streamKey,
      status: 'created',
      process: null,
      hlsPath,
    });

    return {
      streamId,
      rtmpUrl: `rtmp://${this.publicIp}:${port}${this.rtmpBasePath}/${streamKey}`,
    };
  }

  async startStream(
    streamId: string,
    youtubeStreamKey?: string,
  ): Promise<{ message: string; hlsUrl?: string }> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error('Stream not found');
    if (stream.status !== 'created') throw new Error('Stream already started');
    console.log({ stream });
    const inputUrl = `rtmp://0.0.0.0:${stream.port}${this.rtmpBasePath}/${stream.streamKey}`;
    const youtubeUrl = youtubeStreamKey
      ? `rtmp://a.rtmp.youtube.com/live2/${youtubeStreamKey}`
      : null;

    const ffmpegArgs = ['-loglevel', 'verbose', '-listen', '1', '-i', inputUrl];

    // Add YouTube output
    if (youtubeUrl) {
      ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy', '-f', 'flv', youtubeUrl);
    }

    // Add HLS output
    ffmpegArgs.push(
      // Video encoding
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-g',
      '60',
      '-sc_threshold',
      '0',

      // Audio encoding
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',

      // HLS settings
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+independent_segments',
      '-hls_segment_filename',
      path.join(stream.hlsPath, 'segment_%03d.ts'),
      path.join(stream.hlsPath, 'stream.m3u8'),
    );

    console.log(
      `🚀 Starting FFmpeg for stream ${streamId} on port ${stream.port}`,
    );
    console.log(`Command: ffmpeg ${ffmpegArgs.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    stream.process = ffmpeg;
    stream.status = 'listening';

    // Handle FFmpeg output
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      console.log(`[${streamId}] FFmpeg: ${msg.trim()}`);

      if (msg.includes('Opening') && msg.includes('.ts')) {
        console.log(`[${streamId}] HLS segment created`);
      }

      if (msg.includes('Opening') && msg.includes('.m3u8')) {
        console.log(`[${streamId}] HLS playlist updated`);
      }
    });

    ffmpeg.on('close', (code) => {
      console.log(`[${streamId}] FFmpeg exited with code ${code}`);
      stream.status = 'ended';
    });

    ffmpeg.on('error', (err) => {
      console.error(`[${streamId}] FFmpeg error: ${err.message}`);
      stream.status = 'error';
    });

    return {
      message: 'Stream listener started',
      hlsUrl: `${process.env.BASE_URL}/hls/${streamId}/stream.m3u8`,
    };
  }
}
