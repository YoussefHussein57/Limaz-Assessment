import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // Validate configuration BEFORE building the Nest container. A misconfigured
  // process should never reach the point of opening a port.
  const env = loadEnv();

  const app = await NestFactory.create(AppModule);

  // Lets Nest run onModuleDestroy hooks (closing the Prisma connection) when
  // the container receives SIGTERM, instead of dropping it on the floor.
  app.enableShutdownHooks();

  // 0.0.0.0, not localhost: inside a container, binding to the loopback
  // interface makes the port unreachable from outside the container.
  await app.listen(env.API_PORT, '0.0.0.0');

  new Logger('Bootstrap').log(
    `API listening on port ${env.API_PORT} (NODE_ENV=${env.NODE_ENV})`,
  );
}

void bootstrap();
