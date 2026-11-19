import path from 'node:path';

/**
 * Resolves DATABASE_URL for test runs, in order of precedence:
 *
 *   1. An explicitly exported DATABASE_URL (CI, or a one-off override).
 *   2. apps/api/.env, if the developer created one.
 *   3. The documented local default, which matches the compose defaults in
 *      .env.example with the HOST port (5433), not the in-network port.
 *
 * Step 3 exists so that `docker compose up -d db && npm test` works on a fresh
 * clone with no extra setup. The values are the published development
 * defaults from .env.example - there is no secret here, and nothing in this
 * file is used by the running application.
 */
const LOCAL_DEFAULT_DATABASE_URL =
  'postgresql://limaz:limaz_dev_only_password@localhost:5433/limaz?schema=public';

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
  } catch {
    // No local .env - fall through to the documented default below.
  }
}

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = LOCAL_DEFAULT_DATABASE_URL;
}

process.env.NODE_ENV = 'test';

// Concurrency tests must not be serialised by the pool itself (risk R-10).
process.env.DB_POOL_MAX ??= '10';
