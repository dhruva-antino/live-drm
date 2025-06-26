import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: '*', // or set to your frontend URL like 'http://localhost:3000'
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    },
  });  const configService = app.get(ConfigService);
  console.log(configService.get('PORT'))
  await app.listen(configService.get('PORT') || 3000);
}
bootstrap();