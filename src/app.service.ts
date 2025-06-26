import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as os from 'os';
import path, { join } from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as mime from 'mime-types';
import * as portfinder from 'portfinder';
import { v4 as uuidv4 } from 'uuid';
import { HttpService } from '@nestjs/axios';
import { getRootDirectoryPath } from './utils';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { lastValueFrom } from 'rxjs';
import axios from 'axios';

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
  };
}

// interface Stream {
//   id: string;
//   port: number;
//   streamKey: string;
//   status: 'created' | 'listening' | 'active' | 'ended' | 'error';
//   process: any;
//   youtubeUrl?: string;
// }

@Injectable()
export class AppService {
  private ffmpegProcess: any;
  private readonly httpService: HttpService;
  private activeStreams: Map<string, ActiveStream> = new Map();
  private readonly logger = new Logger(AppService.name);
  private hlsBasePath = path.join(process.cwd(), 'hls');
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
      srtUrl: `srt://0.0.0.0:${port}?streamid=#!::r=${streamKey}`,
    };
  }

  async startListenerSRT(streamId: string, options?: StreamOptions) {
    const stream = this.activeStreams.get(streamId);
    if (!stream || stream.status !== 'created')
      return 'Stream not found or already started';
    stream.timings = {
      ffmpegStart: Date.now(),
      ffmpegActive: 0,
      firstFileUploadStart: 0,
      firstFileUploadEnd: 0,
      ffmpegExit: 0,
    };
    let firstFileUploaded = false;

    const srtUrl = `srt://0.0.0.0:${stream.port}?mode=listener&streamid=#!::r=${stream.streamKey}`;

    const outputPath = path.join(stream.outputDir, 'master.m3u8');
    console.time('Time starts for ffmpeg ------>');
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '100M',
      '-probesize',
      '100M',
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
        '6',
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
        '6',
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

    ffmpeg.on('close', (code) => {
      console.log(`[${streamId}] ffmpeg exited with ${code}`);
      stream.status = 'ended';
      stream.timings.ffmpegExit = Date.now();
      console.log(
        `[${streamId}] FFmpeg runtime: ${stream.timings.ffmpegExit - stream.timings.ffmpegStart}ms`,
      );
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

    // const watcher = chokidar.watch(stream.outputDir, {
    //   persistent: true,
    //   ignoreInitial: true,
    //   awaitWriteFinish: {
    //     stabilityThreshold: 300,
    //     pollInterval: 100,
    //   },
    // });

    // watcher.on('add', async (filePath) => {
    //   if (!filePath.endsWith('.ts') && !filePath.endsWith('.m3u8')) return;
    //   try {
    //     const fileStream = fs.createReadStream(filePath);
    //     const contentType = mime.lookup(filePath) || 'application/octet-stream';
    //     const key = path
    //       .join(s3Prefix, path.relative(stream.outputDir, filePath))
    //       .replace(/\\/g, '/');

    //     await this.s3.send(
    //       new PutObjectCommand({
    //         Bucket: bucket,
    //         Key: key,
    //         Body: fileStream,
    //         ContentType: contentType,
    //         ACL: 'public-read', // 👈 Ensure files are publicly accessible for HLS
    //       }),
    //     );

    //     console.log(`[S3] Uploaded ${key}`);
    //   } catch (err) {
    //     console.error(`[S3] Upload failed for ${filePath}`, err);
    //   }
    // });

    stream.playbackUrl = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Prefix}/master.m3u8`;

    return {
      message: `Live stream started`,
      s3PlaybackUrl: stream.playbackUrl,
    };
  }

  private stringToBase64String(input: string): string {
    return Buffer.from(input, 'utf-8').toString('base64');
  }

  private async base64StringToString(base64: string): Promise<string> {
    return Buffer.from(base64, 'base64').toString('utf-8');
  }

  private base64StringToHexString(base64: string): string {
    return this.bytesToHexString(Buffer.from(base64, 'base64'));
  }

  private bytesToHexString(bytes: Buffer): string {
    return bytes.toString('hex').toUpperCase();
  }

  private hexStringToBuffer(hex: string): Buffer {
    return Buffer.from(hex, 'hex');
  }

  private psshDataAsBase64ToPsshBoxAsHex(
    psshDataAsBase64: string,
    drmType: DRM_Type,
  ): string {
    let systemIdBigEndianBytes: number[];
    console.log(
      'Hello from psshDataAsBase64ToPsshBoxAsHex',
      psshDataAsBase64,
      drmType,
    );
    switch (drmType) {
      case DRM_Type.WIDEVINE:
        systemIdBigEndianBytes = [
          0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27,
          0xdc, 0xd5, 0x1d, 0x21, 0xed,
        ];
        break;
      case DRM_Type.PLAYREADY:
        systemIdBigEndianBytes = [
          0x9a, 0x04, 0xf0, 0x79, 0x98, 0x40, 0x42, 0x86, 0xab, 0x92, 0xe6,
          0x5b, 0xe0, 0x88, 0x5f, 0x95,
        ];
        break;
      default:
        throw new Error('Unsupported DRM type');
    }

    const dataBytes = Buffer.from(psshDataAsBase64, 'base64');
    const boxLength = 32 + dataBytes.length;
    const boxLengthBigEndianBuffer = Buffer.alloc(4);
    boxLengthBigEndianBuffer.writeUInt32BE(boxLength, 0);

    const dataLengthBigEndianBuffer = Buffer.alloc(4);
    dataLengthBigEndianBuffer.writeUInt32BE(dataBytes.length, 0);

    const boxBytes: Buffer[] = [
      boxLengthBigEndianBuffer,
      Buffer.from([0x70, 0x73, 0x73, 0x68]), // 'pssh'
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // version/flags
      Buffer.from(systemIdBigEndianBytes),
      dataLengthBigEndianBuffer,
      dataBytes,
    ];

    const fullBox = Buffer.concat(boxBytes);
    return this.bytesToHexString(fullBox);
  }

  private generateRandomHex(length: number): string {
    return randomBytes(length / 2).toString('hex');
  }

  // 3. Update resolution validation
  private validateResolutions(requestedResolutions: string[]): string[] {
    const valid: string[] = [];
    const availableResolutions = Object.keys(RES_CONFIG);

    for (const res of requestedResolutions) {
      if (availableResolutions.includes(res)) {
        valid.push(res);
      } else {
        console.warn(
          `[WARNING] Skipping invalid resolution: ${res}. Supported: ${availableResolutions.join(', ')}`,
        );
      }
    }

    // Default to 720p if no valid resolutions
    if (valid.length === 0) {
      console.warn('No valid resolutions provided. Using default: 720p');
      valid.push('720p');
    }

    return valid;
  }

  private async getDRMKeysFromServer(
    keyId: string,
    scheme: EncryptionSchemes,
  ): Promise<{
    keyId: string;
    contentKey: string;
    iv: string;
    pssh: string;
  }> {
    try {
      // 1. Validate required environment variables
      const requiredEnvVars = [
        'WIDEVINE_SIGNING_KEY',
        'WIDEVINE_SIGNING_IV',
        'WIDEVINE_PROVIDER_NAME',
        'KEY_SERVER_URL',
      ];

      const missingVars = requiredEnvVars.filter(
        (varName) => !process.env[varName],
      );
      if (missingVars.length > 0) {
        throw new Error(
          `Missing environment variables: ${missingVars.join(', ')}`,
        );
      }

      // 2. Create requests using validated env vars
      const contentKeyRequest = this.createContentKeyRequest(keyId, scheme);
      const keyServerRequest = this.createKeyServerRequest(
        contentKeyRequest,
        process.env.WIDEVINE_SIGNING_KEY,
        process.env.WIDEVINE_SIGNING_IV,
        process.env.WIDEVINE_PROVIDER_NAME,
      );

      // 3. Validate keyServerRequest is a non-empty string
      if (
        typeof keyServerRequest !== 'string' ||
        keyServerRequest.trim() === ''
      ) {
        throw new Error('keyServerRequest is not a valid JSON string');
      }

      // 4. Parse the request safely
      let parsedRequest;
      try {
        parsedRequest = JSON.parse(keyServerRequest);
      } catch (parseError) {
        throw new Error(
          `Failed to parse keyServerRequest: ${parseError.message}`,
        );
      }

      console.log({
        url: process.env.KEY_SERVER_URL,
        keyServerRequest: parsedRequest,
      });

      // 5. Make the request
      const response = await axios.post(
        process.env.KEY_SERVER_URL, // Now validated to exist
        parsedRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      console.log({ response: 'I am response', data: response.data.response });
      // 6. Handle response
      const contentKeyResponse = response.data.response;
      return {
        keyId: contentKeyResponse.key_id,
        contentKey: contentKeyResponse.content_key,
        iv: contentKeyResponse.key_iv,
        pssh: this.psshDataAsBase64ToPsshBoxAsHex(
          contentKeyResponse,
          DRM_Type.WIDEVINE,
        ),
      };
    } catch (error) {
      console.error(
        'DRM key request failed:',
        error.response?.data || error.message,
      );
      throw new Error(`DRM key request failed: ${error.message}`);
    }
  }

  private createContentKeyRequest(
    keyId: string,
    scheme: EncryptionSchemes,
  ): string {
    const base64ContentKeyId = this.stringToBase64String(keyId);

    const contentKeyRequest = {
      content_id: base64ContentKeyId,
      drm_types: ['WIDEVINE', 'PLAYREADY', 'FAIRPLAY'],
      protection_scheme: scheme,
      tracks: [{ type: 'SD' }],
    };

    return JSON.stringify(contentKeyRequest);
  }

  private createKeyServerRequest(
    contentKeyRequestJSON: string,
    signingKeyAsHex: string,
    signingIvAsHex: string,
    signer: string,
  ): string {
    const signature = this.createSignature(
      contentKeyRequestJSON,
      signingKeyAsHex,
      signingIvAsHex,
    );

    const keyServerRequest = {
      request: this.stringToBase64String(contentKeyRequestJSON),
      signature,
      signer,
    };

    return JSON.stringify(keyServerRequest);
  }

  private createSignature(
    contentKeyRequestJSON: string,
    signingKeyAsHex: string,
    signingIvAsHex: string,
  ): string {
    const requestBytes = Buffer.from(contentKeyRequestJSON, 'utf-8');
    const sha1Hash = createHash('sha1').update(requestBytes).digest();

    const key = this.hexStringToBuffer(signingKeyAsHex);
    const iv = this.hexStringToBuffer(signingIvAsHex);

    if (key.length !== 32) {
      throw new Error(
        `Invalid key length: expected 32 bytes, got ${key.length}`,
      );
    }
    if (iv.length !== 16) {
      throw new Error('Invalid IV length for CBC mode: expected 16 bytes');
    }

    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(sha1Hash), cipher.final()]);

    return encrypted.toString('base64');
  }

  // Live DRM Streaming Implementation
  async startDRMProtectedStream(streamId: string, options: any) {
    const validResolutions = this.validateResolutions(options.resolutions);

    const port = 9000 + Math.floor(Math.random() * 1000);
    const streamKey = `stream_${Date.now()}`;
    const outputDir = join(getRootDirectoryPath(), 'streams', streamId);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const stream: Stream = {
      id: streamId,
      port,
      streamKey,
      outputDir,
      status: 'created',
      timings: {},
      packagerProcesses: new Map(),
    };

    this.activeStreams.set(streamId, stream);

    // Generate DRM configuration
    const keyId = this.generateRandomHex(32);
    const drmConfig = await this.getDRMKeysFromServer(
      keyId,
      EncryptionSchemes.CBCS,
    );

    // Start FFmpeg ingestion
    this.startFFmpegIngestion(stream, options.resolutions);

    // Start packagers for each resolution
    for (const res of options.resolutions) {
      await this.startPackagerForResolution(stream, res, drmConfig);
    }

    // Generate master playlist
    this.generateMasterPlaylist(stream, options.resolutions, drmConfig);

    // Start file watcher for S3 upload
    // this.startS3UploadWatcher(stream);

    return {
      message: 'DRM protected stream started',
      playbackUrl: stream.playbackUrl,
    };
  }

  private startFFmpegIngestion(stream: Stream, resolutions: string[]) {
    const srtUrl = `srt://0.0.0.0:${stream.port}?mode=listener&streamid=#!::r=${stream.streamKey}`;
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '100M',
      '-probesize',
      '100M',
      '-i',
      srtUrl,
    ];

    resolutions.forEach((res, index) => {
      console.log({ res });
      const config = RES_CONFIG[res];
      console.log({ config });
      const port = this.getResolutionPort(stream, res);

      ffmpegArgs.push(
        '-vf',
        `scale=${config.width}:${config.height}`,
        '-c:v',
        'libx264',
        '-b:v',
        config.videoBitrate,
        '-c:a',
        'aac',
        '-b:a',
        config.audioBitrate,
        '-f',
        'mpegts',
        `udp://127.0.0.1:${port}?pkt_size=1316`,
      );
    });

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    stream.process = ffmpeg;
    stream.status = 'listening';

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Input #0')) {
        stream.status = 'active';
        stream.timings.ffmpegActive = Date.now();
      }
      console.log(`[${stream.id}] ffmpeg:`, msg.trim());
    });

    ffmpeg.on('close', (code) => {
      console.log(`[${stream.id}] ffmpeg exited with ${code}`);
      stream.status = 'ended';
      stream.timings.ffmpegExit = Date.now();

      // Clean up packager processes
      stream.packagerProcesses?.forEach((proc) => proc.kill());
    });
  }

  private getResolutionPort(stream: Stream, resolution: string): number {
    const basePort = stream.port;
    const resIndex = Object.keys(RES_CONFIG).indexOf(resolution);
    return basePort + 100 + resIndex;
  }

  private async startPackagerForResolution(
    stream: Stream,
    resolution: string,
    drmConfig: any,
  ) {
    const port = this.getResolutionPort(stream, resolution);
    const outputPath = join(stream.outputDir, resolution);
    const config = RES_CONFIG[resolution];
    console.log({ stream, drmConfig });
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }
    try {
      fs.accessSync(this.shakaPackagerPath);
    } catch (err) {
      console.error(`Packager executable error: ${err.message}`);
      throw new Error('Invalid packager configuration');
    }

    const shakaArgs = [
      `input=udp://127.0.0.1:${port}?reuse=1,stream=video,init_segment="${join(outputPath, 'video_init.mp4')}",segment_template="${join(outputPath, 'video_$Number$.m4s')}"`,
      `input=udp://127.0.0.1:${port}?reuse=1,stream=audio,init_segment="${join(outputPath, 'audio_init.mp4')}",segment_template="${join(outputPath, 'audio_$Number$.m4s')}"`,
      '--enable_raw_key_encryption',
      `--keys=key_id=${drmConfig.keyId}:key=${drmConfig.contentKey}`,
      `--pssh=${drmConfig.pssh}`,
      `--protection_scheme=${EncryptionSchemes.CBCS}`,
      `--hls_master_playlist_output="${join(outputPath, 'playlist.m3u8')}"`,
      '--hls_playlist_type=LIVE',
      '--segment_duration=4',
      '--fragment_duration=4',
      '--clear_lead=0',
    ];
    const packager = spawn(this.shakaPackagerPath, shakaArgs);
    stream.packagerProcesses?.set(resolution, packager);

    packager.stdout.on('data', (data) => {
      console.log(`[${stream.id}-${resolution}] packager: ${data}`);
    });

    packager.stderr.on('data', (data) => {
      console.error(`[${stream.id}-${resolution}] packager error: ${data}`);
    });

    packager.on('close', (code) => {
      console.log(`[${stream.id}-${resolution}] packager exited with ${code}`);
    });
  }

  private generateMasterPlaylist(
    stream: Stream,
    resolutions: string[],
    drmConfig: any,
  ) {
    let masterPlaylist = '#EXTM3U\n';
    masterPlaylist += '#EXT-X-VERSION:6\n';
    masterPlaylist += '#EXT-X-INDEPENDENT-SEGMENTS\n';

    // Add DRM key information
    masterPlaylist += `#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://${drmConfig.keyId}",KEYID=0x${drmConfig.keyId},KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n\n`;

    resolutions.forEach((res) => {
      const config = RES_CONFIG[res];
      const bandwidth =
        parseInt(config.videoBitrate) * 1000 +
        parseInt(config.audioBitrate) * 1000;

      masterPlaylist += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${config.width}x${config.height},CODECS="avc1.64001f,mp4a.40.2"\n`;
      masterPlaylist += `${res}/playlist.m3u8\n\n`;
    });

    const masterPath = join(stream.outputDir, 'master.m3u8');
    fs.writeFileSync(masterPath, masterPlaylist);

    stream.playbackUrl = `${process.env.CDN_BASE_URL}/${stream.id}/master.m3u8`;
  }

  // private startS3UploadWatcher(stream: Stream) {
  //   const watcher = chokidar.watch(stream.outputDir, {
  //     persistent: true,
  //     ignoreInitial: true,
  //     awaitWriteFinish: {
  //       stabilityThreshold: 300,
  //       pollInterval: 100,
  //     },
  //   });

  //   watcher.on('add', (path) => this.uploadToS3(stream, path));
  //   watcher.on('change', (path) => this.uploadToS3(stream, path));
  // }

  // private async uploadToS3(stream: Stream, filePath: string) {
  //   if (
  //     !filePath.endsWith('.ts') &&
  //     !filePath.endsWith('.m4s') &&
  //     !filePath.endsWith('.mp4') &&
  //     !filePath.endsWith('.m3u8')
  //   ) {
  //     return;
  //   }

  //   try {
  //     const fileStream = fs.createReadStream(filePath);
  //     const s3Prefix = `live-streams/${streamId}`;

  //     const contentType = mime.lookup(filePath) || 'application/octet-stream';
  //     const key = path
  //       .join(s3Prefix, path.relative(stream.outputDir, filePath))
  //       .replace(/\\/g, '/');

  //     await this.s3.send(
  //       new PutObjectCommand({
  //         Bucket: process.env.AWS_S3_BUCKET,
  //         Key: key,
  //         Body: fileStream,
  //         ContentType: contentType,
  //         ACL: 'public-read',
  //       }),
  //     );
  //     console.log(`Uploaded ${key} to S3`);
  //   } catch (err) {
  //     console.error(`S3 upload failed for ${filePath}:`, err);
  //   }
  // }

  createStream(port: number, streamKey: string): string {
    console.log({ port, streamKey });
    // if (!this.validateStreamKey(streamKey)) {
    //   throw new Error('Invalid stream key format');
    // }

    const streamId = `stream-${Date.now()}-${port}`;
    const outputDir = path.join(this.hlsBasePath, streamId);

    fs.mkdirSync(outputDir, { recursive: true });
    console.log('stream');
    this.activeStreams.set(streamId, {
      port,
      streamKey,
      status: 'created',
      process: null,
      outputDir,
      lastActivity: Date.now(),
      playbackUrl: `${this.getBaseUrl()}/hls/${streamId}/master.m3u8`,
      streamId,
    });

    return JSON.stringify({
      streamId,
      playbackUrl: `${this.getBaseUrl()}/hls/${streamId}/master.m3u8`,
      rtmpUrl: `rtmp://127.0.0.1:1935/live/${streamKey}`,
      srtUrl: `srt://0.0.0.0:${port}?streamid=#!::r=${streamKey}`,
    });
  }

  // startListener(streamId: string) {
  //   const stream = this.activeStreams.get(streamId);

  //   if (!stream) throw new Error('Stream not found');
  //   if (stream.status !== 'created') return 'Stream already started';

  //   const srtUrl = `srt://0.0.0.0:${stream.port}?mode=listener&streamid=#!::r=${stream.streamKey}`;
  //   const outputPath = path.join(stream.outputDir, 'master.m3u8');
  //   const ffmpegArgs = [
  //     '-hide_banner',
  //     '-loglevel',
  //     'log',
  //     '-fflags',
  //     '+genpts',
  //     '-analyzeduration',
  //     '100M',
  //     '-probesize',
  //     '100M',
  //     '-i',
  //     srtUrl,

  //     // Split input and scale
  //     '-filter_complex',
  //     '[0:v]split=2[v1][v2];' +
  //       '[v1]scale=w=1280:h=720:force_original_aspect_ratio=decrease[v720];' +
  //       '[v2]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[v1080]',

  //     // Mapping variant streams
  //     '-map',
  //     '[v720]',
  //     '-map',
  //     'a:0?',
  //     '-map',
  //     '[v1080]',
  //     '-map',
  //     'a:0?',

  //     // Encoding for both variants
  //     '-c:v',
  //     'libx264',
  //     '-b:v:0',
  //     '3000k',
  //     '-b:v:1',
  //     '5000k',
  //     '-preset',
  //     'veryfast',

  //     '-c:a',
  //     'aac',
  //     '-b:a:0',
  //     '128k',
  //     '-b:a:1',
  //     '128k',

  //     // Output format
  //     '-f',
  //     'hls',
  //     '-hls_time',
  //     '4',
  //     '-hls_list_size',
  //     '6',
  //     '-hls_flags',
  //     'delete_segments+independent_segments',
  //     '-master_pl_name',
  //     'master.m3u8',
  //     '-var_stream_map',
  //     'v:0,a:0,name:stream_720p v:1,a:1,name:stream_1080p',
  //     '-hls_segment_filename',
  //     path.join(stream.outputDir, 'stream_%v', 'segment_%03d.ts'),
  //     path.join(stream.outputDir, 'stream_%v', 'stream.m3u8'),
  //   ];

  //   const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  //   stream.process = ffmpeg;
  //   stream.status = 'listening';

  //   ffmpeg.stdout.on('data', (data) => {
  //     console.debug(`[${streamId}] STDOUT: ${data.toString().trim()}`);
  //   });

  //   ffmpeg.stderr.on('data', (data) => {
  //     const output = data.toString();
  //     if (output.includes('Input #0')) stream.status = 'active';
  //     console.log(`[${streamId}] FFMPEG: ${output.trim()}`);
  //   });

  //   ffmpeg.on('close', (code) => {
  //     console.log(`[${streamId}] FFmpeg exited with code ${code}`);
  //     stream.status = code === 0 ? 'completed' : 'failed';

  //     // Schedule cleanup after 1 hour
  //     setTimeout(() => {
  //       this.cleanupStream(streamId);
  //     }, 3600000);
  //   });

  //   // return `Stream ${streamId} started. Playback URL: ${this.getBaseUrl()}/hls/${streamId}/master.m3u8`;
  //   return {
  //     message: `Stream ${streamId} started.`,
  //     playbackUrl: ` ${this.getBaseUrl()}/hls/${streamId}/master.m3u8`,
  //   };
  // }

  startListener(
    streamId: string,
    transcodeOptions?: Array<{ resolution: string; bitrate?: string }>,
  ) {
    const stream = this.activeStreams.get(streamId);
    if (!stream) throw new Error('Stream not found');
    if (stream.status !== 'created') return 'Stream already started';

    const srtUrl = `srt://0.0.0.0:${stream.port}?mode=listener&streamid=#!::r=${stream.streamKey}`;
    const outputPath = path.join(stream.outputDir, 'master.m3u8');

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'info',
      '-fflags',
      '+genpts',
      '-analyzeduration',
      '100M',
      '-probesize',
      '100M',
      '-i',
      srtUrl,
    ];

    if (transcodeOptions && transcodeOptions.length > 0) {
      const filterParts = transcodeOptions.map((option, idx) => {
        const [w, h] = option.resolution.split('x');
        return `[0:v]scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease[v${idx}]`;
      });

      ffmpegArgs.push('-filter_complex', filterParts.join(';'));

      transcodeOptions.forEach((_, idx) => {
        ffmpegArgs.push('-map', `[v${idx}]`, '-map', 'a:0?');
      });

      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'veryfast');

      transcodeOptions.forEach((option, idx) => {
        ffmpegArgs.push(`-b:v:${idx}`, option.bitrate || '2500k');
      });

      ffmpegArgs.push('-c:a', 'aac');
      transcodeOptions.forEach((_, idx) => {
        ffmpegArgs.push(`-b:a:${idx}`, '128k');
      });

      ffmpegArgs.push(
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_list_size',
        '6',
        '-hls_flags',
        'delete_segments+independent_segments',
        '-master_pl_name',
        'master.m3u8',
        '-var_stream_map',
        transcodeOptions
          .map((_, idx) => `v:${idx},a:${idx},name:stream_${idx}`)
          .join(' '),
        '-hls_segment_filename',
        path.join(stream.outputDir, 'stream_%v', 'segment_%03d.ts'),
        path.join(stream.outputDir, 'stream_%v', 'stream.m3u8'),
      );
    } else {
      // No transcode — just segment original input
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
        '6',
        '-hls_flags',
        'delete_segments+independent_segments',
        '-hls_segment_filename',
        path.join(stream.outputDir, 'segment_%03d.ts'),
        outputPath,
      );
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    stream.process = ffmpeg;
    stream.status = 'listening';

    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Input #0')) stream.status = 'active';
      console.log(`[${streamId}] FFMPEG: ${output.trim()}`);
    });

    ffmpeg.on('close', (code) => {
      console.log(`[${streamId}] FFmpeg exited with code ${code}`);
      stream.status = code === 0 ? 'completed' : 'failed';
      setTimeout(() => this.cleanupStream(streamId), 3600000); // cleanup after 1 hour
    });

    return {
      message: `Stream ${streamId} started.`,
      playbackUrl: `${this.getBaseUrl()}/hls/${streamId}/master.m3u8`,
    };
  }

  // createStream(port: number, streamKey: string): any {
  //   const streamId = `stream-${Date.now()}-${port}`;
  //   const outputDir = path.join(this.hlsBasePath, streamId);

  //   fs.mkdirSync(outputDir, { recursive: true });

  //   const rtmpBase = process.env.RTMP_BASE_URL || 'rtmp://127.0.0.1';
  //   const rtmpPushUrl = `${rtmpBase}:${port}/live/${streamKey}`;

  //   this.activeStreams.set(streamId, {
  //     port,
  //     streamKey,
  //     status: 'created',
  //     process: null,
  //     outputDir,
  //     playbackUrl: '',
  //     streamId,
  //     rtmpUrl: rtmpPushUrl,
  //     lastActivity: Date.now(),
  //   });

  //   return {
  //     streamId,
  //     rtmpPushUrl,
  //     obsConfig: {
  //       server: `${rtmpBase}:${port}/live`,
  //       streamKey: streamKey,
  //     },
  //     playbackUrl: `${this.getBaseUrl()}/hls/${streamId}/master.m3u8`,
  //   };
  // }

  // async startListenerRTMP(streamId: string, options?: StreamOptions) {
  //   console.log('I am in start listener ------------->     ');
  //   const stream = this.activeStreams.get(streamId);
  //   // if (!stream || stream.status !== 'created')
  //   //     return { error: 'Stream not found or already started' };

  //   // YouTube configuration
  //   const youtubeRtmp = 'rtmp://a.rtmp.youtube.com/live2';
  //   const youtubeStreamKey =
  //     process.env.YOUTUBE_STREAM_KEY || 'your-default-key';
  //   const youtubeUrl = `${youtubeRtmp}/${youtubeStreamKey}`;

  //   // Input configuration
  //   const inputRtmpUrl = stream.rtmpUrl;
  //   const outputPath = path.join(stream.outputDir, 'master.m3u8');

  //   // Base FFmpeg arguments
  //   const ffmpegArgs = [
  //     '-hide_banner',
  //     '-loglevel',
  //     'info',
  //     '-fflags',
  //     '+genpts',
  //     '-analyzeduration',
  //     '100M',
  //     '-probesize',
  //     '100M',
  //     '-listen',
  //     '1',
  //     '-timeout',
  //     '300000',
  //     '-i',
  //     inputRtmpUrl,
  //   ];

  //   // Create filter complex for HLS transcoding
  //   if (options?.resolutions?.length > 0) {
  //     const filterParts: string[] = [];
  //     const varStreamMap: string[] = [];
  //     const videoBitrates: string[] = [];

  //     // Create split filter to preserve original for YouTube
  //     const splitCount = options.resolutions.length;
  //     filterParts.push(
  //       `[0:v]split=${splitCount + 1}${options.resolutions.map((_, i) => `[v${i}in]`).join('')}[yt_out]`,
  //     );

  //     // Add scaling filters
  //     options.resolutions.forEach((res, index) => {
  //       const width = res.width % 2 === 0 ? res.width : res.width + 1;
  //       const height = res.height % 2 === 0 ? res.height : res.height + 1;
  //       filterParts.push(
  //         `[v${index}in]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2[v${index}out]`,
  //       );
  //       varStreamMap.push(`v:${index},a:${index},name:${height}p`);
  //       videoBitrates.push(
  //         `-b:v:${index}`,
  //         res.bitrate || this.defaultBitrate(height),
  //       );
  //     });

  //     // Add audio split
  //     filterParts.push(
  //       `[0:a]asplit=${options.resolutions.length}${options.resolutions.map((_, i) => `[a${i}]`).join('')}`,
  //     );

  //     ffmpegArgs.push('-filter_complex', filterParts.join(';'));

  //     // Add YouTube output (using the preserved original)
  //     ffmpegArgs.push(
  //       '-map',
  //       '[yt_out]',
  //       '-map',
  //       '0:a',
  //       '-c:v',
  //       'copy',
  //       '-c:a',
  //       'copy',
  //       '-f',
  //       'flv',
  //       youtubeUrl,
  //     );

  //     // Add HLS outputs
  //     const mapArgs: string[] = [];
  //     options.resolutions.forEach((_, i) => {
  //       mapArgs.push('-map', `[v${i}out]`);
  //       mapArgs.push('-map', `[a${i}]`);
  //     });

  //     ffmpegArgs.push(
  //       ...mapArgs,
  //       '-c:v',
  //       'libx264',
  //       ...videoBitrates,
  //       '-preset',
  //       'veryfast',
  //       '-g',
  //       '60',
  //       '-sc_threshold',
  //       '0',
  //       '-c:a',
  //       'aac',
  //       '-b:a',
  //       '128k',
  //       '-f',
  //       'hls',
  //       '-hls_time',
  //       '4',
  //       '-hls_list_size',
  //       '6',
  //       '-hls_flags',
  //       'independent_segments+program_date_time+append_list',
  //       '-master_pl_name',
  //       'master.m3u8',
  //       '-var_stream_map',
  //       varStreamMap.join(' '),
  //       '-hls_segment_filename',
  //       path.join(stream.outputDir, 'stream_%v', 'segment_%03d.ts'),
  //       path.join(stream.outputDir, 'stream_%v', 'stream.m3u8'),
  //     );

  //     // Create directories
  //     for (let i = 0; i < options.resolutions.length; i++) {
  //       const dirPath = path.join(stream.outputDir, `stream_${i}`);
  //       fs.mkdirSync(dirPath, { recursive: true, mode: 0o777 });
  //     }
  //   } else {
  //     // Single quality output
  //     ffmpegArgs.push(
  //       '-c:v',
  //       'copy',
  //       '-c:a',
  //       'aac',
  //       '-b:a',
  //       '128k',
  //       '-f',
  //       'hls',
  //       '-hls_time',
  //       '4',
  //       '-hls_list_size',
  //       '6',
  //       '-hls_flags',
  //       'independent_segments+program_date_time+append_list',
  //       '-hls_segment_filename',
  //       path.join(stream.outputDir, 'segment_%03d.ts'),
  //       outputPath,
  //       '-c:v',
  //       'copy',
  //       '-c:a',
  //       'copy',
  //       '-f',
  //       'flv',
  //       youtubeUrl,
  //     );
  //   }

  //   console.log(`[${streamId}] Starting FFmpeg on port ${stream.port}`);
  //   console.log(`[${streamId}] Command: ffmpeg ${ffmpegArgs.join(' ')}`);

  //   const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
  //     stdio: ['ignore', 'pipe', 'pipe'],
  //   });

  //   stream.process = ffmpeg;
  //   stream.status = 'listening';

  //   // Enhanced FFmpeg logging
  //   ffmpeg.stderr.on('data', (data) => {
  //     const msg = data.toString();
  //     console.log(`[${streamId}] FFmpeg: ${msg.trim()}`);

  //     // Input detection
  //     if (msg.includes('Input #0')) {
  //       console.log(`[${streamId}] Input stream detected`);
  //       stream.status = 'active';
  //     }

  //     // YouTube output status
  //     if (msg.includes(youtubeUrl)) {
  //       if (msg.includes('Connection established')) {
  //         console.log(`[${streamId}] YouTube connection successful`);
  //       }
  //       if (msg.includes('Failed to connect')) {
  //         console.error(`[${streamId}] YouTube connection failed`);
  //       }
  //     }

  //     // HLS output status
  //     if (msg.includes('Opening') && msg.includes('.ts')) {
  //       console.log(
  //         `[${streamId}] Segment created: ${msg.split('for writing').pop()}`,
  //       );
  //     }
  //     if (msg.includes('master.m3u8')) {
  //       console.log(`[${streamId}] Master playlist updated`);
  //     }

  //     // Error detection
  //     if (msg.includes('error') || msg.includes('failed')) {
  //       console.error(`[${streamId}] FFmpeg error: ${msg.trim()}`);
  //     }
  //   });

  //   // Process event handlers
  //   ffmpeg.on('close', (code) => {
  //     console.log(`[${streamId}] FFmpeg exited with code ${code}`);
  //     stream.status = 'ended';
  //     this.cleanupStream(streamId);
  //   });

  //   ffmpeg.on('error', (err) => {
  //     console.error(`[${streamId}] FFmpeg spawn error: ${err.message}`);
  //     stream.status = 'error';
  //   });

  //   // Setup S3 uploader
  //   this.setupS3Uploader(streamId, stream.outputDir);

  //   // Generate playback URL
  //   const bucket = process.env.AWS_S3_BUCKET;
  //   const region = process.env.AWS_REGION;
  //   const s3Prefix = `live-streams/${streamId}`;
  //   stream.playbackUrl = `https://${bucket}.s3.${region}.amazonaws.com/${s3Prefix}/master.m3u8`;

  //   return {
  //     message: `Live stream processing started`,
  //     s3PlaybackUrl: stream.playbackUrl,
  //     youtubeStream: `https://youtube.com/live/${youtubeStreamKey}`,
  //     rtmpPushUrl: stream.rtmpUrl,
  //   };
  // }

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

    const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';
    const youtubeUrl = `${rtmpUrl}/${youtubeKey}`;
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

      // Key changes for segment retention:
      '-hls_time',
      '4', // Segment duration (4 seconds)
      '-hls_list_size',
      '0', // 0 = keep all segments in playlist
      '-hls_flags',
      'append_list+independent_segments', // Append mode
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

      // Add HLS-specific logging
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

  private defaultBitrate(height: number): string {
    if (height <= 360) return '800k';
    if (height <= 480) return '1400k';
    if (height <= 720) return '2800k';
    if (height <= 1080) return '5000k';
    return '8000k';
  }

  private cleanupStream(streamId: string) {
    const stream = this.activeStreams.get(streamId);
    if (stream) {
      try {
        if (stream.process) stream.process.kill('SIGKILL');
        fs.rmSync(stream.outputDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Cleanup failed for ${streamId}:`, e);
      }
      this.activeStreams.delete(streamId);
      console.log(`Cleaned up stream ${streamId}`);
    }
  }

  private validateStreamKey(key: string): boolean {
    return /^[a-zA-Z0-9_-]{6,}$/.test(key);
  }

  private getBaseUrl(): string {
    return process.env.BASE_URL || 'http://localhost:3333';
  }

  //  createStream(port: number, streamKey: string): string {
  //   const streamId = `stream-${Date.now()}`;

  //   // Create temporary file path
  //   const tempDir = os.tmpdir();
  //   const fileName = `${streamId}.ts`;
  //   const filePath = path.join(tempDir, fileName);

  //   this.activeStreams.set(streamId, {
  //     port,
  //     streamKey,
  //     status: 'created',
  //     process: null,
  //     filePath
  //   });

  //   return JSON.stringify({
  //     id: streamId,
  //     message: `Stream created. Will listen on port ${port}`,
  //     filePath
  //   });
  // }

  // startListener(streamId: string): string {
  //   const stream = this.activeStreams.get(streamId);

  //   if (!stream) {
  //     throw new Error('Stream not found');
  //   }

  //   if (stream.status !== 'created') {
  //     return 'Stream already started or completed';
  //   }

  //   // Start FFmpeg process
  //   const srtUrl = `srt://0.0.0.0:${stream.port}?mode=listener&streamid=#!::r=${stream.streamKey}`;

  //   console.log(`Starting FFmpeg for ${streamId} on port ${stream.port}`);
  //   console.log(`Output file: ${stream.filePath}`);

  //   const ffmpeg = spawn('ffmpeg', [
  //     '-hide_banner',
  //     '-loglevel', 'verbose',  // Increased verbosity
  //     '-fflags', '+genpts',    // Generate missing PTS
  //     '-i', srtUrl,
  //     '-c', 'copy',
  //     '-f', 'mpegts',
  //     stream.filePath          // Output to file
  //   ]);

  //   stream.process = ffmpeg;
  //   stream.status = 'listening';

  //   ffmpeg.stdout.on('data', (data) => {
  //     console.log(`[${streamId}] STDOUT: ${data.length} bytes`);
  //   });

  //   ffmpeg.stderr.on('data', (data) => {
  //     const output = data.toString();
  //     console.log(`[${streamId}] FFMPEG: ${output}`);

  //     // Detect connection
  //     if (output.includes('Connection established')) {
  //       stream.status = 'active';
  //       console.log(`[${streamId}] Stream connected!`);
  //     }
  //   });

  //   ffmpeg.on('close', (code) => {
  //     console.log(`[${streamId}] FFmpeg exited with code ${code}`);
  //     stream.status = code === 0 ? 'completed' : 'failed';
  //   });

  //   return `Listening on port ${stream.port} for key ${stream.streamKey}\nFile: ${stream.filePath}`;
  // }

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
