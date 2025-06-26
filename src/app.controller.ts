import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AppService, StreamOptions } from './app.service';

console.log({
  signingKeyAsHex: process.env.WIDEVINE_SIGNING_KEY,
  signingIvAsHex: process.env.WIDEVINE_SIGNING_IV,
  signer: process.env.WIDEVINE_PROVIDER_NAME,
  keyServerUrl: process.env.KEY_SERVER_URL,
});
@Controller('createStream')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('create')
  createStream(@Query('port') port: number, @Query('key') key: string): string {
    return this.appService.createStream(port, key);
  }

  // @Post('start')
  // startListener(@Query('id') id: string) {
  //   return this.appService.startListener(id);
  // }

  // @Post('start')
  // startListener(
  //   @Query('id') id: string,
  //   @Body('transcodeOptions')
  //   transcodeOptions?: Array<{
  //     resolution: '720p' | '1080p' | '480p';
  //     bitrate?: string;
  //   }>,
  // ) {
  //   return this.appService.startListener(id, transcodeOptions);
  // }

  // @Post('start')
  // async startListener(
  //   @Query('id') streamId: string,
  //   @Body()
  //   body: {
  //     resolutions?: { width: number; height: number; bitrate?: string }[];
  //   },
  // ) {
  //   if (!streamId) {
  //     throw new BadRequestException('Missing stream ID in query');
  //   }

  //   if (body?.resolutions) {
  //     for (const res of body.resolutions) {
  //       if (
  //         typeof res.width !== 'number' ||
  //         typeof res.height !== 'number' ||
  //         (res.bitrate && typeof res.bitrate !== 'string')
  //       ) {
  //         throw new BadRequestException(
  //           'Invalid resolution format: width/height must be numbers, bitrate (optional) must be string',
  //         );
  //       }
  //     }
  //   }

  //   return this.appService.startListener(streamId, body);
  // }

  @Post('start')
  async startListenerSRT(
    @Query('id') streamId: string,
    @Body()
    body: StreamOptions,
  ) {
    if (!streamId) {
      throw new BadRequestException('Missing stream ID');
    }

    // Validate resolutions if present
    if (body.resolutions) {
      for (const res of body.resolutions) {
        if (
          typeof res.width !== 'number' ||
          typeof res.height !== 'number' ||
          (res.bitrate && typeof res.bitrate !== 'string')
        ) {
          throw new BadRequestException(
            'Each resolution must have numeric width and height. Bitrate (if present) must be a string.',
          );
        }
      }
    }

    return this.appService.startListenerSRT(streamId, body);
  }

  @Post('start-drm')
  async startListenerSRTWithDRM(
    @Query('id') streamId: string,
    @Body()
    body: StreamOptions,
  ) {
    if (!streamId) {
      throw new BadRequestException('Missing stream ID');
    }

    // Validate resolutions if present
    // if (body.resolutions) {
    //   for (const res of body.resolutions) {
    //     if (
    //       typeof res.width !== 'number' ||
    //       typeof res.height !== 'number' ||
    //       (res.bitrate && typeof res.bitrate !== 'string')
    //     ) {
    //       throw new BadRequestException(
    //         'Each resolution must have numeric width and height. Bitrate (if present) must be a string.',
    //       );
    //     }
    //   }
    // }
    console.log({
      signingKeyAsHex: process.env.WIDEVINE_SIGNING_KEY,
      signingIvAsHex: process.env.WIDEVINE_SIGNING_IV,
      signer: process.env.WIDEVINE_PROVIDER_NAME,
      keyServerUrl: process.env.KEY_SERVER_URL,
    });
    return this.appService.startDRMProtectedStream(streamId, {
      ...body,
      isDRM: true,
      resolutions: body.resolutions,
      signingKeyAsHex: process.env.WIDEVINE_SIGNING_KEY,
      signingIvAsHex: process.env.WIDEVINE_SIGNING_IV,
      signer: process.env.WIDEVINE_PROVIDER_NAME,
      keyServerUrl: process.env.KEY_SERVER_URL,
    });
  }

  @Post('stop')
  stopListener(@Query('id') id: string): string {
    return this.appService.stopListener(id);
  }

  @Get('status')
  getStatus(@Query('id') id: string): string {
    return this.appService.getStatus(id);
  }

  @Get('active')
  getActiveStreams() {
    const streams = this.appService.getAllActiveStreams(); // should return array of streams
    return { streams };
  }

  @Post('start-simple')
  startSimpleStream(@Body() body: { youtubeKey: string }) {
    return this.appService.startSimpleStream(body.youtubeKey);
  }

  @Post('create-rtmp')
  async createStreamRTMP() {
    return this.appService.createStreamRTMP();
  }

  @Post(':id/start')
  async startStream(
    @Param('id') streamId: string,
    @Body() body: { youtubeKey?: string },
  ) {
    return this.appService.startStream(streamId, body.youtubeKey);
  }
}
