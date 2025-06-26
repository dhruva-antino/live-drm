import { Module } from '@nestjs/common';
import { WorkersService } from './workers.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],  // Add this line
  providers: [WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}