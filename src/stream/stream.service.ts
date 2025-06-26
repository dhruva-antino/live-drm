import { Injectable, Logger } from '@nestjs/common';
import { WorkersService } from '../workers/workers.service';
import { StorageService } from '../storage/storage.service';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { spawn } from 'child_process';

@Injectable()
export class StreamService {
  private activeStreams: Map<
    string,
    { status: string; startTime: Date; resolutions: string[] }
  > = new Map();
  private activeSimulations: Map<string, any> = new Map();
  private readonly logger = new Logger(StreamService.name);

  constructor(
    private workersService: WorkersService,
    private storageService: StorageService,
    private configService: ConfigService,
  ) {}

  async startRtmpSimulation(inputPath: string, streamKey: string) {
    const rtmpUrl = this.configService.get('RTMP_SERVER_URL') || 'rtmp://localhost/live';
    const outputUrl = `${rtmpUrl}/${streamKey}`;

    return new Promise((resolve, reject) => {
        const args = [
            '-re',
            '-stream_loop', '-1',
            '-i', inputPath,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-g', '60',
            '-keyint_min', '60',
            '-sc_threshold', '0',
            '-f', 'flv',
            outputUrl
        ];

        const ffmpegPath = require('ffmpeg-static');
        const ffmpegProcess = spawn(ffmpegPath, args);

        let errorLogged = false;

        ffmpegProcess.stderr.on('data', (data) => {
            const output = data.toString();
            if (output.includes('Connection refused') && !errorLogged) {
                errorLogged = true;
                reject(new Error('RTMP server not running. Please start an RTMP server like Nginx with RTMP module.'));
                ffmpegProcess.kill();
            }
            this.logger.error(`RTMP stderr: ${output}`);
        });

        ffmpegProcess.on('close', (code) => {
            if (code !== 0 && !errorLogged) {
                reject(new Error(`RTMP simulation failed with code ${code}`));
            }
            this.activeSimulations.delete(streamKey);
        });

        this.activeSimulations.set(streamKey, {
            type: 'rtmp',
            process: ffmpegProcess,
            startTime: new Date()
        });

        // Give it a second to check if connection succeeds
        setTimeout(() => {
            if (!errorLogged) {
                resolve({
                    message: 'RTMP simulation started',
                    streamKey,
                    pid: ffmpegProcess.pid
                });
            }
        }, 1000);
    });
}

  // SRT Simulation
  async startSrtSimulation(inputPath: string, streamKey: string) {
    const srtUrl = this.configService.get('SRT_SERVER_URL') || 'srt://localhost:9000';
    const outputUrl = `${srtUrl}?streamid=/${streamKey}`;

    const args = [
      '-re',
      '-stream_loop', '-1',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-f', 'mpegts',
      outputUrl
    ];

    return this.startSimulation('srt', streamKey, args);
  }

  private async startSimulation(type: string, streamKey: string, args: string[]) {
    if (this.activeSimulations.has(streamKey)) {
      throw new Error(`${type.toUpperCase()} simulation already running for ${streamKey}`);
    }

    const ffmpegPath = require('ffmpeg-static');
    const ffmpegProcess = spawn(ffmpegPath, args);

    this.activeSimulations.set(streamKey, {
      type,
      process: ffmpegProcess,
      startTime: new Date()
    });

    ffmpegProcess.stdout.on('data', (data) => {
      this.logger.debug(`${type.toUpperCase()} stdout: ${data}`);
    });

    ffmpegProcess.stderr.on('data', (data) => {
      this.logger.error(`${type.toUpperCase()} stderr: ${data}`);
    });

    ffmpegProcess.on('close', (code) => {
      this.logger.log(`${type.toUpperCase()} simulation ended for ${streamKey} with code ${code}`);
      this.activeSimulations.delete(streamKey);
    });

    return {
      message: `${type.toUpperCase()} simulation started`,
      streamKey,
      pid: ffmpegProcess.pid
    };
  }

  async stopSimulation(streamKey: string) {
    const simulation = this.activeSimulations.get(streamKey);
    if (!simulation) {
      throw new Error(`No active simulation found for ${streamKey}`);
    }

    simulation.process.kill();
    this.activeSimulations.delete(streamKey);
    return { message: 'Simulation stopped', streamKey };
  }

  async getSimulationStatus(streamKey: string) {
    const simulation = this.activeSimulations.get(streamKey);
    if (!simulation) {
      return { status: 'not_found' };
    }

    return {
      type: simulation.type,
      status: 'running',
      uptime: Date.now() - simulation.startTime.getTime(),
      pid: simulation.process.pid
    };
  }

  async startStream(inputPath: string, streamKey: string) {
    if (this.activeStreams.has(streamKey)) {
      return { message: 'Stream already running', streamKey };
    }

    this.activeStreams.set(streamKey, {
      status: 'starting',
      startTime: new Date(),
      resolutions: ['480', '720', '1080'],
    });

    try {
      // Start processing in worker thread
      await this.workersService.processStream(inputPath, streamKey);

      this.activeStreams.get(streamKey).status = 'streaming';
      return { message: 'Stream started successfully', streamKey };
    } catch (error) {
      this.activeStreams.get(streamKey).status = 'error';
      throw error;
    }
  }

  getStreamStatus(streamKey: string) {
    if (!this.activeStreams.has(streamKey)) {
      return { status: 'not_found' };
    }
    return this.activeStreams.get(streamKey);
  }

  async getPlaylistUrls(streamKey: string) {
    const baseUrl = this.configService.get('GCP_PUBLIC_URL');
    const resolutions = ['480', '720', '1080'];

    const playlists = {
      hls: {},
      dash: {},
    };

    for (const res of resolutions) {
      playlists.hls[res] = `${baseUrl}/${streamKey}/hls/${res}/playlist.m3u8`;
      playlists.dash[res] = `${baseUrl}/${streamKey}/dash/${res}/playlist.mpd`;
    }

    return playlists;
  }
}