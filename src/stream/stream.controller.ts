import { Controller, Get, Post, Body, Param, Delete } from '@nestjs/common';
import { StreamService } from './stream.service';

@Controller('stream')
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  @Post('start')
  async startStream(@Body() body: { inputPath: string; streamKey: string }) {
    return this.streamService.startStream(body.inputPath, body.streamKey);
  }

  @Get('status/:streamKey')
  async getStreamStatus(@Param('streamKey') streamKey: string) {
    return this.streamService.getStreamStatus(streamKey);
  }

  @Get('playlist/:streamKey')
  async getPlaylist(@Param('streamKey') streamKey: string) {
    return this.streamService.getPlaylistUrls(streamKey);
  }

   @Post('rtmp')
  async startRtmp(@Body() body: { inputPath: string; streamKey: string }) {
    return this.streamService.startRtmpSimulation(body.inputPath, body.streamKey);
  }

  @Post('srt')
  async startSrt(@Body() body: { inputPath: string; streamKey: string }) {
    return this.streamService.startSrtSimulation(body.inputPath, body.streamKey);
  }

  @Delete(':streamKey')
  async stop(@Param('streamKey') streamKey: string) {
    return this.streamService.stopSimulation(streamKey);
  }

  @Get('status/:streamKey')
  async status(@Param('streamKey') streamKey: string) {
    return this.streamService.getSimulationStatus(streamKey);
  }
}