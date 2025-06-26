import { Injectable } from '@nestjs/common';
import { Worker } from 'worker_threads';
import { join } from 'path';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class WorkersService {
  private workers: Map<string, Worker> = new Map();

  constructor(private storageService: StorageService) {}

  async processStream(inputPath: string, streamKey: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const workerPath = join(__dirname, 'transcode.worker.js');
      const worker = new Worker(workerPath, {
        workerData: { inputPath, streamKey },
      });

      this.workers.set(streamKey, worker);
      console.log('in service')
      worker.on('message', async (message) => {
        console.log({message})
        if (message.type === 'progress') {
          console.log(`Progress for ${streamKey}: ${message.data}%`);
        } else if (message.type === 'segment') {
          console.log('in segment')
          await this.storageService.uploadFile(
            message.data.filePath,
            message.data.key,
          );
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      worker.on('online', () => {
        resolve();
      });
    });
  }

  stopStream(streamKey: string) {
    const worker = this.workers.get(streamKey);
    if (worker) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      this.workers.delete(streamKey);
    }
  }
}