import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as chokidar from 'chokidar';
import * as mime from 'mime-types';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';

interface ActiveStream {
  outputDir: string;
  ffmpegProcess: any;
  inputPipe?: any;
}

interface StreamResolution {
  width: number;
  height: number;
  bitrate?: string;
}

@Injectable()
export class StreamServiceV1 implements OnModuleDestroy {
  private activeStreams: Map<string, ActiveStream> = new Map();
  private s3: S3Client;

  constructor(private configService: ConfigService) {
    this.s3 = new S3Client({
      region: this.configService.get('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  startFFmpeg(streamId: string, resolutions: StreamResolution[] = []) {
    const outputDir = path.join(process.cwd(), 'streams', streamId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const ffmpegArgs: string[] = [
      '-f',
      'webm',
      '-i',
      'pipe:0',
       '-analyzeduration',
      '2M',
      '-probesize',
      '2M',
    ];

    if (resolutions.length > 0) {
      const filterParts: string[] = [];
      const mapArgs: string[] = [];
      const varStreamMap: string[] = [];

      resolutions.forEach((res, idx) => {
        const label = `v${idx}`;
        filterParts.push(
          `[0:v]scale=w=${res.width}:h=${res.height}:force_original_aspect_ratio=decrease[${label}]`,
        );
        mapArgs.push('-map', `[${label}]`, '-map', 'a:0?');
        varStreamMap.push(`v:${idx},a:${idx},name:stream_${res.height}p`);
        ffmpegArgs.push(
          `-b:v:${idx}`,
          res.bitrate || this.defaultBitrate(res.height),
        );
        ffmpegArgs.push(`-b:a:${idx}`, '128k');
      });

      ffmpegArgs.push(
        '-filter_complex',
        filterParts.join(';'),
        ...mapArgs,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
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
      ffmpegArgs.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
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
        path.join(outputDir, 'master.m3u8'),
      );
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg stderr: ${data}`));
    ffmpeg.on('close', (code) =>
      console.log(`FFmpeg exited with code ${code}`),
    );

    this.activeStreams.set(streamId, {
      outputDir,
      ffmpegProcess: ffmpeg,
      inputPipe: ffmpeg.stdin,
    });

    // Upload logic
    const watcher = chokidar.watch(outputDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher.on('add', (filePath) => this.uploadToS3(filePath, streamId));
    watcher.on('change', (filePath) => this.uploadToS3(filePath, streamId));
  }

  writeToFFmpeg(streamId: string, chunk: Buffer) {
    const stream = this.activeStreams.get(streamId);
    if (stream && stream.inputPipe?.writable) {
      stream.inputPipe.write(chunk);
    }
  }

  stopStream(streamId: string) {
    const stream = this.activeStreams.get(streamId);
    if (stream) {
      stream.inputPipe?.end();
      stream.ffmpegProcess.kill('SIGINT');
      this.activeStreams.delete(streamId);
    }
  }

  private async uploadToS3(filePath: string, streamId: string) {
    const stream = this.activeStreams.get(streamId);
    if (!stream) return;

    try {
      const bucket = this.configService.get('AWS_S3_BUCKET');
      const contentType = mime.lookup(filePath) || 'application/octet-stream';
      const key = `live-streams/${streamId}/${path.relative(stream.outputDir, filePath).replace(/\\/g, '/')}`;
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
      console.log(`[S3] Uploaded: ${key}`);
    } catch (err) {
      console.error(`[S3] Upload failed for ${filePath}`, err);
    }
  }

  private defaultBitrate(height: number): string {
    if (height <= 360) return '800k';
    if (height <= 720) return '1500k';
    return '3000k';
  }

  onModuleDestroy() {
    this.activeStreams.forEach((stream) => stream.ffmpegProcess.kill('SIGINT'));
  }
}
