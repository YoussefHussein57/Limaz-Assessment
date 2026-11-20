import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationGuard, AuthorizationGuard, CsrfGuard } from '../../src/auth/guards';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { ENV, ConfigModule } from '../../src/config/config.module';
import { parseEnv } from '../../src/config/env.schema';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { testDatabaseUrl } from '../database-url';
import { ProbeController } from './probe.controller';

export const TEST_APP_ORIGIN = 'http://localhost:3000';

/**
 * Boots the real application wiring against the throwaway test database.
 *
 * The guards, the exception filter and their registration ORDER are the
 * production ones from app.module.ts. They are restated rather than imported
 * because AppModule also pulls in HealthModule and would bind to the
 * development database - but if the order in app.module.ts ever diverges from
 * this, F02-T16 fails, because CsrfGuard has to run BEFORE authentication or
 * login, being @Public(), would skip it entirely.
 *
 * Only the ENV provider is overridden. Everything downstream - PrismaService's
 * connection string, PasswordService's bcrypt cost, CsrfGuard's expected
 * origin - then reads its configuration the ordinary way, through the same
 * injection the running application uses. Overriding individual services
 * instead would mean the tests exercise different objects from production.
 *
 * ProbeController is registered here and NOWHERE else, so none of its routes
 * exist in the deployed application.
 */
export async function createAuthTestApp(
  overrides: Partial<Record<string, string>> = {},
): Promise<{ app: INestApplication; prisma: PrismaClient }> {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN: TEST_APP_ORIGIN,
    SESSION_TTL_HOURS: '8',
    COOKIE_SECURE: 'true',
    BCRYPT_COST: '10',
    DB_POOL_MAX: '10',
    ...overrides,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule],
    controllers: [ProbeController],
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
