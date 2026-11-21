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
import { PolicyModule } from '../../src/policy/policy.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReviewsModule } from '../../src/reviews/reviews.module';
import { testDatabaseUrl } from '../database-url';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

export interface F07TestApp {
  app: INestApplication;
  prisma: PrismaClient;
}

/**
 * The whole application, as F07 needs it.
 *
 * `ExpensesModule` is wired with the REAL policy evaluator, because several
 * of these tests do not assert on strings - they change the policy and then
 * submit an expense to see whether the rule actually fires. A stubbed
 * evaluator would make those tests about the stub.
 */
export async function createF07TestApp(): Promise<F07TestApp> {
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
      PolicyModule,
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
