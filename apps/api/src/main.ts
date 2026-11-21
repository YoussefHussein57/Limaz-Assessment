import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // Validate configuration BEFORE building the Nest container. A misconfigured
  // process should never reach the point of opening a port.
  const env = loadEnv();

  // `rawBody: true` keeps the EXACT bytes of every request body on
  // `request.rawBody`, alongside the parsed object.
  //
  // The card webhook's HMAC signature covers those bytes. `JSON.parse`
  // followed by `JSON.stringify` is not the identity function - it normalises
  // whitespace, drops insignificant formatting, re-encodes unicode escapes
  // and renders `1.0` as `1` - so a verifier built on the parsed object fails
  // every pretty-printed delivery, and, far worse, can be made to verify a
  // body that differs from the one the application then acts on.
  //
  // The cost is one extra Buffer per request, bounded by the same body-size
  // limit that already applies. Nothing but the webhook route reads it.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Express announces itself on every response with `X-Powered-By: Express`.
  //
  // It defends nothing to remove it - an attacker who cares can fingerprint
  // the stack from error shapes and header ordering anyway, and this is not
  // claimed as a security control. It is removed because it is free
  // reconnaissance given away for no benefit: it names the framework whose
  // CVE list to start from, on every single response, including to callers
  // who have not authenticated.
  //
  // Found by the F13 QA regression pass, MIN-01.
  app.getHttpAdapter().getInstance().disable('x-powered-by');

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
