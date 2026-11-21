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

/**
 * F12 requires a webhook encryption key in every environment, with no default.
 *
 * It is set here rather than in each harness because the F00 health test boots
 * the REAL `AppModule`, which calls `loadEnv()` against `process.env` - and a
 * missing variable there is `process.exit(1)` from inside a test run, which
 * aborts the whole suite with a configuration message rather than a failure
 * anybody can read.
 *
 * `??=`, so a harness that wants a different key can still set one.
 */
process.env.WEBHOOK_ENCRYPTION_KEY ??= 'bGltYXotdGVzdC13ZWJob29rLWVuYy1rZXktMzJieXQ=';

/** The background worker must not run in a suite that did not ask for it. */
process.env.WEBHOOK_WORKER_ENABLED ??= 'false';
