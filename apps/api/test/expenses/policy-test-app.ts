import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type INestApplication,
  type NestInterceptor,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import type { Observable } from 'rxjs';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationGuard, AuthorizationGuard, CsrfGuard } from '../../src/auth/guards';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { ConfigModule, ENV } from '../../src/config/config.module';
import { parseEnv } from '../../src/config/env.schema';
import { ExpensesModule } from '../../src/expenses/expenses.module';
import { FREQUENCY_LOCK, type FrequencyLock } from '../../src/expenses/frequency-lock';
import { PolicyEngineEvaluator } from '../../src/expenses/policy/policy-engine.evaluator';
import { POLICY_EVALUATOR, type PolicyEvaluator } from '../../src/expenses/policy-evaluator.port';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { testDatabaseUrl } from '../database-url';
import { Barrier } from './test-policy-evaluator';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

/**
 * Holds every request before the controller runs - and therefore before the
 * transaction opens and before the advisory lock is attempted.
 *
 * THIS PLACEMENT IS THE WHOLE POINT. F03's barrier lives inside the
 * evaluator, which runs AFTER the lock is granted. That works for requests
 * with different lock keys, and would deadlock for requests that share one:
 * only the holder can proceed, so the others never arrive and everyone waits.
 *
 * Here the barrier is upstream of the lock, so five requests for the SAME
 * employee can all be genuinely in flight, and then race for the lock the way
 * five real clients would.
 *
 * Registered only in this test factory. Nothing like it exists in AppModule.
 */
@Injectable()
export class RequestBarrierInterceptor implements NestInterceptor {
  private barrier: Barrier | null = null;

  /** Arms the barrier for the next `size` requests. */
  arm(size: number, timeoutMs = 10_000): void {
    this.barrier = new Barrier(size, timeoutMs);
  }

  disarm(): void {
    this.barrier = null;
  }

  async intercept(_context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (this.barrier) {
      await this.barrier.arrive();
    }

    return next.handle();
  }
}

/** A lock that does nothing. Used ONLY by the frequency negative control. */
export class NoopFrequencyLock implements FrequencyLock {
  async acquire(): Promise<void> {
    // Deliberately empty. Removing the serialisation is the experiment.
  }
}

/**
 * Wraps the real evaluator and pauses AFTER the frequency count and BEFORE
 * the submission persists anything.
 *
 * Needed because a barrier before the lock proves the requests overlapped,
 * but does NOT prove they read the same count: without serialisation, one
 * transaction can still count, insert and commit before another gets as far
 * as counting, and the negative control would then pass by accident.
 *
 * Pausing between the count and the write makes every competitor observe the
 * same pre-insert state, which makes "all five decided APPROVE" a determined
 * outcome rather than a likely one.
 *
 * MUST NOT be used while the real advisory lock is in place: competitors
 * sharing a lock key cannot all reach this point, so they would deadlock
 * until the timeout. It is only ever paired with NoopFrequencyLock.
 */
export class CountThenPauseEvaluator implements PolicyEvaluator {
  private barrier: Barrier | null = null;

  constructor(private readonly inner: PolicyEvaluator) {}

  arm(size: number, timeoutMs = 10_000): void {
    this.barrier = new Barrier(size, timeoutMs);
  }

  async evaluate(input: Parameters<PolicyEvaluator['evaluate']>[0]) {
    // The real count, against the real transaction.
    const result = await this.inner.evaluate(input);

    if (this.barrier) {
      await this.barrier.arrive();
    }

    return result;
  }
}

export interface PolicyTestApp {
  app: INestApplication;
  prisma: PrismaClient;
  barrier: RequestBarrierInterceptor;
}

/**
 * Boots the application with the REAL policy evaluator.
 *
 * Everything under test is production code: the rules, the evaluator, the
 * frequency query, the transaction, the advisory lock, the guards and the
 * exception filter. Nothing is mocked. The only additions are the request
 * barrier, which changes timing and not behaviour, and - when a test asks for
 * them - the two negative-control substitutions above.
 *
 * `DB_POOL_MAX` is 10 and must stay above the concurrency of every test here.
 * With a smaller pool the requests queue inside the pool, run one at a time,
 * and the suite passes without the database having been contended at all
 * (risk R-10).
 */
export async function createPolicyTestApp(
  options: {
    /** Replaces the advisory lock with a no-op. Negative control only. */
    unlocked?: boolean;
    /** Wraps the real evaluator so it pauses between count and persist. */
    pauseAfterCount?: boolean;
  } = {},
): Promise<PolicyTestApp & { pausing?: CountThenPauseEvaluator }> {
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

  const interceptor = new RequestBarrierInterceptor();
  const pausing = options.pauseAfterCount
    ? new CountThenPauseEvaluator(new PolicyEngineEvaluator())
    : undefined;

  let builder = Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      AuthModule,
      // The REAL evaluator - the same expression AppModule uses.
      ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator }),
    ],
    providers: [
      { provide: APP_GUARD, useClass: CsrfGuard },
      { provide: APP_GUARD, useClass: AuthenticationGuard },
      { provide: APP_GUARD, useClass: AuthorizationGuard },
      { provide: APP_INTERCEPTOR, useValue: interceptor },
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ],
  })
    .overrideProvider(ENV)
    .useValue(env);

  if (options.unlocked) {
    // The experiment: the production code path, with the serialisation gone.
    // Reachable only through this testing API - there is no flag.
    builder = builder.overrideProvider(FREQUENCY_LOCK).useValue(new NoopFrequencyLock());
  }

  if (pausing) {
    builder = builder.overrideProvider(POLICY_EVALUATOR).useValue(pausing);
  }

  const moduleRef = await builder
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

  return { app, prisma: app.get(PrismaService), barrier: interceptor, pausing };
}
