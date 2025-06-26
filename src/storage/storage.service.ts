import { Injectable } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StorageService {
  private storage: Storage;
  private bucketName: string;

  constructor(private configService: ConfigService) {
    this.storage = new Storage({
      projectId: this.configService.get('GCP_PROJECT_ID'),
      keyFilename: this.configService.get('GCP_KEY_FILE'),
    });
    this.bucketName = this.configService.get('GCP_BUCKET_NAME');
  }

  async uploadFile(filePath: string, destination: string): Promise<void> {
    await this.storage.bucket(this.bucketName).upload(filePath, {
      destination,
      public: true,
    });
  }

  async uploadDirectory(directoryPath: string, prefix: string): Promise<void> {
    const files = fs.readdirSync(directoryPath);
    
    for (const file of files) {
      const fullPath = path.join(directoryPath, file);
      const stats = fs.statSync(fullPath);
      
      if (stats.isDirectory()) {
        await this.uploadDirectory(fullPath, `${prefix}/${file}`);
      } else {
        const destination = `${prefix}/${file}`;
        await this.uploadFile(fullPath, destination);
      }
    }
  }

  async getSignedUrl(filename: string): Promise<string> {
    const [url] = await this.storage
      .bucket(this.bucketName)
      .file(filename)
      .getSignedUrl({
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000,
      });

    return url;
  }
}