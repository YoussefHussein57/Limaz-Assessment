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
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { PasswordService } from '../../src/auth/password.service';
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
import { Barrier } from '../expenses/test-policy-evaluator';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

/**
 * Holds requests before the controller runs, and therefore before the
 * conditional UPDATE acquires any row lock.
 *
 * PLACEMENT IS THE POINT, and it is the F04 lesson applied again. Once the
 * winning transaction holds the review's row lock, every competitor blocks
 * INSIDE PostgreSQL - not at any barrier of ours. A shared barrier downstream
 * of that could never be reached by more than one participant, so it would
 * hang until its timeout. Upstream, all competitors are genuinely in flight
 * and then race for the row the way real managers would.
 */
@Injectable()
export class RequestBarrierInterceptor implements NestInterceptor {
  private barrier: Barrier | null = null;

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

export interface ReviewsTestApp {
  app: INestApplication;
  prisma: PrismaClient;
  barrier: RequestBarrierInterceptor;
}

/**
 * Boots the real review wiring against the throwaway test database.
 *
 * Everything is production code: the guards and their order, the exception
 * filter, the controller, both services, the conditional UPDATE and the
 * transaction. Nothing is substituted - F05 has no seam to fill, because
 * unlike the expense endpoint it has no dependency that did not exist.
 *
 * `ExpensesModule` is wired with the real evaluator so tests can CREATE a
 * review the way production does, rather than inserting one by hand and
 * hoping the shape matches.
 *
 * `DB_POOL_MAX` is 10, above the concurrency of every test here. With a
 * smaller pool the competing requests would queue inside the pool and
 * serialise there, and the suite would pass without the database being
 * contended at all (risk R-10).
 */
export async function createReviewsTestApp(): Promise<ReviewsTestApp> {
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

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      AuthModule,
      ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator }),
      ReviewsModule,
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

  return { app, prisma: app.get(PrismaService), barrier: interceptor };
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

/**
 * A manager session for a company, created in the TEST database only.
 *
 * The production seed gives one manager per company, which cannot express
 * "two managers race for the same review". Adding a second manager to the
 * seed to serve a test would change what a reviewer sees when they run the
 * application, so the extra accounts live here instead.
 *
 * The password is generated per call and never leaves this process.
 */
export async function createTestManager(
  app: INestApplication,
  prisma: PrismaClient,
  companyId: string,
  label: string,
): Promise<{ userId: string; cookie: string; email: string }> {
  const passwords = app.get(PasswordService);

  const email = `${label}@test.invalid`;
  const password = `Test-${label}-${Math.random().toString(36).slice(2, 12)}`;

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      companyId,
      role: 'MANAGER',
      displayName: `Test Manager ${label}`,
      passwordHash: await passwords.hash(password),
    },
    update: { passwordHash: await passwords.hash(password), companyId },
  });

  return { userId: user.id, cookie: await login(app, email, password), email };
}
