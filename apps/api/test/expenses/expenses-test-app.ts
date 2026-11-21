import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationGuard, AuthorizationGuard, CsrfGuard } from '../../src/auth/guards';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { ConfigModule, ENV } from '../../src/config/config.module';
import { parseEnv } from '../../src/config/env.schema';
import { ExpensesModule } from '../../src/expenses/expenses.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { testDatabaseUrl } from '../database-url';
import { TestPolicyEvaluator } from './test-policy-evaluator';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

/**
 * Boots the real expense wiring against the throwaway test database.
 *
 * Everything except the policy evaluator is production code: the guards and
 * their order, the exception filter, the DTO, the submission service, the
 * transaction, the advisory lock and the conflict classification. Only the
 * `POLICY_EVALUATOR` token is bound here, because no production implementation
 * of it exists until F04 - which is precisely why `ExpensesModule` is not in
 * `AppModule`.
 *
 * `DB_POOL_MAX` is 10 and must stay above the concurrency of every test in
 * this directory. With a pool of one, concurrent requests queue inside the
 * pool and run sequentially; the test then passes without the database having
 * been contended at all, and proves nothing (risk R-10).
 */
export async function createExpensesTestApp(
  evaluator: TestPolicyEvaluator = new TestPolicyEvaluator(),
  overrides: Partial<Record<string, string>> = {},
): Promise<{ app: INestApplication; prisma: PrismaClient; evaluator: TestPolicyEvaluator }> {
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
    ...overrides,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      AuthModule,
      // The only way to wire this module is to name an evaluator, which is
      // what keeps the production application from having one by accident.
      ExpensesModule.withEvaluator({ useValue: evaluator }),
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

  return { app, prisma: app.get(PrismaService), evaluator };
}
