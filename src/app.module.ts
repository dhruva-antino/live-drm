import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { StreamModule } from './stream/stream.module';
import { StorageModule } from './storage/storage.module';
import { WorkersModule } from './workers/workers.module';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HttpModule,
    ScheduleModule.forRoot(),
    // ThrottlerModule.forRoot({
    //   ttl: 60,
    //   limit: 100,
    // }),
    StreamModule,
    StorageModule,
    WorkersModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'hls'),
      serveRoot: '/hls',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
  //  providers: [
  //   {
  //     provide: APP_GUARD,
  //     useClass: ThrottlerGuard,
  //   },
  // ],
})
export class AppModule {}
