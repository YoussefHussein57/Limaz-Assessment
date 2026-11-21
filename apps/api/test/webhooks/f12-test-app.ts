import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { createServer } from 'node:net';
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
import { SimulatorModule } from '../../src/simulator/simulator.module';
import { WebhookProcessorService } from '../../src/webhooks/webhook-processor.service';
import { WebhookWorkerService } from '../../src/webhooks/webhook-worker.service';
import { WebhooksModule } from '../../src/webhooks/webhooks.module';
import { testDatabaseUrl } from '../database-url';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

/** The same 32-byte test key every other harness uses. */
export const TEST_ENCRYPTION_KEY = 'bGltYXotdGVzdC13ZWJob29rLWVuYy1rZXktMzJieXQ=';

export interface F12TestApp {
  app: INestApplication;
  prisma: PrismaClient;
  worker: WebhookWorkerService;
  processor: WebhookProcessorService;
  /** The port the app is actually listening on. The simulator posts to it. */
  port: number;
}

export interface F12Options {
  /** Default false: the worker is driven one event at a time by the tests. */
  workerEnabled?: boolean;
  sandboxEnabled?: boolean;
  toleranceSeconds?: number;
  maxAttempts?: number;
  claimLeaseSeconds?: number;
}

/**
 * The card webhook pipeline, end to end, on a real port.
 *
 * ===========================================================================
 * WHY THIS ONE LISTENS, WHEN EVERY OTHER HARNESS USES supertest ALONE
 * ===========================================================================
 *
 * The sandbox simulator is only worth testing if it does what it claims: sign
 * a request and **send it over HTTP** to the real webhook endpoint. Calling
 * the intake service in process would test a shortcut that does not exist in
 * the product.
 *
 * So the app binds a real port, and `API_PORT` is set to that same port
 * BEFORE the container is built - the simulator computes its fixed
 * destination from configuration at construction time, which is exactly the
 * property that makes it immune to a caller-supplied URL.
 *
 * ===========================================================================
 * WHY THE WORKER IS OFF BY DEFAULT
 * ===========================================================================
 *
 * A background timer would make every assertion a race. With it off, the
 * tests call `worker.drainOne()` and the sentence "the event was processed"
 * is something they caused rather than something they waited for. The F04
 * lesson, applied to a queue: a test that sleeps is a test that passes for
 * the wrong reason on a slow machine.
 */
export async function createF12TestApp(options: F12Options = {}): Promise<F12TestApp> {
  const port = await findFreePort();

  const env = parseEnv({
    NODE_ENV: 'test',
    API_PORT: String(port),
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN: TEST_APP_ORIGIN,
    SESSION_TTL_HOURS: '8',
    COOKIE_SECURE: 'true',
    BCRYPT_COST: '10',
    DB_POOL_MAX: '10',
    WEBHOOK_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    WEBHOOK_TOLERANCE_SECONDS: String(options.toleranceSeconds ?? 300),
    WEBHOOK_MAX_ATTEMPTS: String(options.maxAttempts ?? 5),
    WEBHOOK_CLAIM_LEASE_SECONDS: String(options.claimLeaseSeconds ?? 60),
    WEBHOOK_POLL_INTERVAL_MS: '100',
    WEBHOOK_WORKER_ENABLED: options.workerEnabled ? 'true' : 'false',
    SANDBOX_SIMULATOR_ENABLED: options.sandboxEnabled === false ? 'false' : 'true',
  });

  const expenses = ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      PrismaModule,
      AuthModule,
      expenses,
      ReviewsModule,
      AdminModule,
      WebhooksModule.forExpenses(expenses),
      SimulatorModule,
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

  // `rawBody: true`, exactly as main.ts sets it. Without it `request.rawBody`
  // is undefined and every signature check fails - which would look like a
  // verification defect rather than a harness that is not the application.
  const app = moduleRef.createNestApplication({ rawBody: true });

  await app.init();
  await app.listen(port, '127.0.0.1');

  return {
    app,
    prisma: app.get(PrismaService),
    worker: app.get(WebhookWorkerService),
    processor: app.get(WebhookProcessorService),
    port,
  };
}

/**
 * Asks the operating system for a port nobody is using.
 *
 * A hardcoded one collides with a developer's dev stack, or with a parallel
 * jest worker - and the failure is a confusing EADDRINUSE several tests
 * later rather than at the point of conflict.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
