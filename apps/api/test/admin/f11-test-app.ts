import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
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
import { ReviewsModule } from '../../src/reviews/reviews.module';
import { testDatabaseUrl } from '../database-url';
import { TEST_APP_ORIGIN } from './f08-test-app';

export interface F11TestApp {
  app: INestApplication;
  prisma: PrismaClient;
}

/**
 * Administration, expense submission AND the review lifecycle.
 *
 * The last one is why this exists rather than reusing `createF08TestApp`.
 * F11's closing claim is not "a manager account was created" - it is that an
 * account created through the API can SIGN IN AND RESOLVE A REVIEW, which is
 * what closing R-32 actually means. Without `ReviewsModule` the resolve route
 * does not exist and the test would see a 404: a harness gap that looks
 * exactly like a product defect, and which cost a debugging round when this
 * suite was first written.
 *
 * `ExpensesModule` carries the REAL evaluator, so the review being resolved
 * was opened by the real policy engine rather than inserted by the test.
 */
export async function createF11TestApp(): Promise<F11TestApp> {
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
