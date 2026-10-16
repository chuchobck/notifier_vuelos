import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { LoggerJson, nivelesPorEntorno } from './common/logger/logger-json';
import { configurarApp } from './configurar-app';

async function bootstrap() {
  // JSON desde la primera línea: también un error de arranque (una variable que falta)
  const logger = new LoggerJson(undefined, nivelesPorEntorno(process.env.NODE_ENV));
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  configurarApp(app, { logger });
  app.enableShutdownHooks();

  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}
bootstrap();
