import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AdminModule } from '../../src/admin/admin.module';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationGuard, AuthorizationGuard, CsrfGuard } from '../../src/auth/guards';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { ConfigModule, ENV } from '../../src/config/config.module';
import { parseEnv } from '../../src/config/env.schema';
import { ExpensesModule } from '../../src/expenses/expenses.module';
import { PolicyEngineEvaluator } from '../../src/expenses/policy/policy-engine.evaluator';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { testDatabaseUrl } from '../database-url';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

export interface F08TestApp {
  app: INestApplication;
  prisma: PrismaClient;
}

/**
 * The admin surface plus expense submission.
 *
 * `ExpensesModule` is wired with the real evaluator because the decisive
 * tests here do not assert on strings: they take a key the admin endpoint
 * just minted and submit a real expense with it. "The response contained a
 * key" and "the key authenticates" are different claims, and only the second
 * one matters.
 *
 * `DB_POOL_MAX` is 10, above the concurrency of the rotation race below. With
 * a smaller pool the competing requests would queue in the pool and serialise
 * there, and the test would pass without the database being contended at all
 * (the F04 lesson, risk R-10).
 */
export async function createF08TestApp(): Promise<F08TestApp> {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN: TEST_APP_ORIGIN,
    SESSION_TTL_HOURS: '8',
    COOKIE_SECURE: 'true',
    BCRYPT_COST: '10',
    DB_POOL_MAX: '10',
    // F12 requires this in every environment, with no default - see the
    // comment in env.schema.ts. A fixed test value, because an encryption
    // key that changed between runs would make a sealed secret unreadable.
    WEBHOOK_ENCRYPTION_KEY: 'bGltYXotdGVzdC13ZWJob29rLWVuYy1rZXktMzJieXQ=',
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      AuthModule,
      ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator }),
      AdminModule,
    ],
    providers: [
      { provide: APP_GUARD, useClass: CsrfGuard },
      { provide: APP_GUARD, useClass: AuthenticationGuard },
      { provide: APP_GUARD, useClass: AuthorizationGuard },
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .setLogger({
      log: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      verbose: () => {},
    })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return { app, prisma: app.get(PrismaService) };
}

export async function login(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .set('origin', TEST_APP_ORIGIN)
    .set('x-limaz-client', '1')
    .send({ email, password })
    .expect(200);

  const setCookie = response.headers['set-cookie'] as unknown as string[];
  const header = setCookie.find((value) => value.startsWith('limaz_session='));

  if (!header) {
    throw new Error('no session cookie was issued');
  }

  return header.split(';')[0]!;
}

/** The headers a browser session sends. */
export function asUser(cookie: string): Record<string, string> {
  return { Cookie: cookie, origin: TEST_APP_ORIGIN, 'x-limaz-client': '1' };
}
