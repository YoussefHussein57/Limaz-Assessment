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

  // There is deliberately NO app.enableCors().
  //
  // CORS is not a lock the server applies; it is permission the server grants.
  // With no CORS headers the browser's default - deny - stands, which is the
  // strictest posture available. Enabling CORS could only ever open access
  // that is currently closed.
  //
  // It is not needed because the browser never makes a cross-origin request
  // here: Next.js proxies /api/* server-side, so from the browser's point of
  // view everything is same-origin (ADR-008). Company backends authenticate
  // with an API key from server code, where CORS does not apply at all.
  //
  // Cross-origin requests are instead refused by CsrfGuard, which checks the
  // Origin header on the server rather than trusting the browser to enforce
  // it. Test F00-T05b asserts no access-control-allow-origin header is ever
  // sent, because its presence would mean the deployment is no longer
  // same-origin.

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
