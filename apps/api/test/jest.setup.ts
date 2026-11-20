import { resolveDatabaseUrl } from './database-url';

/**
 * Per-test-file setup.
 *
 * DATABASE_URL here is the DEVELOPMENT database, used only by the F00 health
 * end-to-end test, which boots the real AppModule. The F01 integration tests
 * do not read it: they build their own connection string for `limaz_test`
 * through test/database-url.ts.
 */
process.env.DATABASE_URL = resolveDatabaseUrl();
process.env.NODE_ENV = 'test';

// Concurrency tests must not be serialised by the pool itself (risk R-10).
process.env.DB_POOL_MAX ??= '10';
