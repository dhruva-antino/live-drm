import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createServer, Server } from 'http';
import { WsAdapter } from '@nestjs/platform-ws';
// import { SignalingGateway } from './signaling.gateway1';
import { WebSocketServer } from 'ws'; // Import from ws

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: {
      origin: '*', // or set to your frontend URL like 'http://localhost:3000'
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    },
  });

  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });
  // app.useStaticAssets(join(__dirname, '..', 'public'));
  // app.useWebSocketAdapter(new WsAdapter(app));
  // const httpServer: Server = app.getHttpServer();
  // const wss = new WebSocketServer({ server: httpServer, path: '/signaling' });

  // const signalingGateway = app.get(SignalingGateway);
  // (signalingGateway as any).server = wss;
  const configService = app.get(ConfigService);
  // console.log(configService.get('PORT'));
  await app.listen(configService.get('PORT') || 3000);
}
bootstrap();
