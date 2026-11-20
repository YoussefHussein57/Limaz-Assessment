import path from 'node:path';

/**
 * One place that decides which PostgreSQL the test suite talks to.
 *
 * Both jest's globalSetup (which runs in the main process) and the test files
 * (which run in worker processes) need this. Rather than having globalSetup
 * mutate process.env and hope the value reaches the workers, each computes the
 * same answer from the same inputs.
 */

/** Development-only, and identical to the defaults published in .env.example. */
const LOCAL_DEFAULT_DATABASE_URL =
  'postgresql://limaz:limaz_dev_only_password@localhost:5433/limaz?schema=public';

/**
 * Integration tests run against their own database, never the development one.
 * They assert exact row counts and deliberately insert rows that violate
 * constraints; doing that to the database a reviewer is looking at would be
 * both destructive and non-deterministic.
 */
export const TEST_DATABASE_NAME = 'limaz_test';

/** Rewrites a connection string to point at a different database name. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Precedence: an explicitly exported DATABASE_URL, then apps/api/.env, then
 * the documented local default. The last step is what lets
 * `docker compose up -d db && npm test` work on a fresh clone.
 */
export function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  try {
    process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
  } catch {
    // No local .env - fall through to the documented default.
  }

  return process.env.DATABASE_URL ?? LOCAL_DEFAULT_DATABASE_URL;
}

export function testDatabaseUrl(): string {
  return withDatabase(resolveDatabaseUrl(), TEST_DATABASE_NAME);
}

export function adminDatabaseUrl(): string {
  // You cannot drop a database you are connected to, so maintenance commands
  // run against the always-present `postgres` database.
  return withDatabase(resolveDatabaseUrl(), 'postgres');
}
