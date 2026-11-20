import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationGuard, AuthorizationGuard, CsrfGuard } from '../../src/auth/guards';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { ConfigModule, ENV } from '../../src/config/config.module';
import { parseEnv } from '../../src/config/env.schema';
import { DashboardModule } from '../../src/dashboard/dashboard.module';
import { ExpensesModule } from '../../src/expenses/expenses.module';
import { PolicyEngineEvaluator } from '../../src/expenses/policy/policy-engine.evaluator';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReviewsModule } from '../../src/reviews/reviews.module';
import { testDatabaseUrl } from '../database-url';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

export interface F06TestApp {
  app: INestApplication;
  prisma: PrismaClient;
}

/**
 * Boots the F06 read surface against the throwaway test database.
 *
 * Everything is production code: the guards in their real order, the real
 * exception filter, the real controllers and services. Nothing is
 * substituted - these are read endpoints with no seam to fill.
 *
 * `ExpensesModule` is wired with the real policy evaluator and `ReviewsModule`
 * is included, so a test can CREATE an expense and RESOLVE its review exactly
 * the way production does. Inserting rows by hand would let a test assert a
 * shape the application never produces.
 */
export async function createF06TestApp(): Promise<F06TestApp> {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN: TEST_APP_ORIGIN,
    SESSION_TTL_HOURS: '8',
    COOKIE_SECURE: 'true',
    BCRYPT_COST: '10',
    DB_POOL_MAX: '10',
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      AuthModule,
      ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator }),
      ReviewsModule,
      DashboardModule,
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

/** Signs in and returns the session cookie, ready for a `Cookie` header. */
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

/** The headers a browser session sends: cookie, origin and the client marker. */
export function asManager(cookie: string): Record<string, string> {
  return { Cookie: cookie, origin: TEST_APP_ORIGIN, 'x-limaz-client': '1' };
}
