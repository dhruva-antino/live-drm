import { Module } from '@nestjs/common';
import { StreamController } from './stream.controller';
import { StreamService } from './stream.service';
import { StorageService } from '../storage/storage.service';
import { WorkersService } from '../workers/workers.service';

@Module({
  controllers: [StreamController],
  providers: [StreamService, StorageService, WorkersService],
})
export class StreamModule {}