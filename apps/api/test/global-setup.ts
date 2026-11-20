import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { TEST_DATABASE_NAME, adminDatabaseUrl, testDatabaseUrl } from './database-url';
import { acquireSuiteLock } from './suite-lock';

/**
 * Creates a throwaway test database and applies the migrations to it.
 *
 * WHY A SEPARATE DATABASE:
 *
 * These tests assert on exact row counts and insert rows that violate
 * constraints on purpose. Running them against the development database would
 * destroy the seeded data a reviewer is looking at, and the counts would
 * depend on whatever happened to be there already.
 *
 * Recreating it here is also what makes F01-T01 a real test: the migrations
 * are applied to a genuinely empty database on every run, not to one that
 * already has the tables.
 *
 * This only ever touches a database literally named `limaz_test`.
 */
export default async function globalSetup(): Promise<void> {
  // FIRST, before anything destructive. Two runs dropping and recreating this
  // database at the same moment break each other, and the symptom points
  // nowhere near the cause - see test/suite-lock.ts and AI_LOG 36.
  await acquireSuiteLock();

  const admin = new Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();

  try {
    // FORCE terminates connections left behind by a crashed run. Without it,
    // the database stays undroppable until the container restarts. Needs
    // PostgreSQL 13 or newer; we run 17.
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DATABASE_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
  } finally {
    await admin.end();
  }

  // The real CLI, not a hand-executed SQL file: F01-T01 is about
  // `prisma migrate deploy` working, including the CHECK constraints appended
  // by hand to the init migration.
  //
  // Invoked through node directly rather than through `npx` in a shell. No
  // shell means no command-string parsing, and it resolves identically on
  // Windows where `npx` is a .cmd wrapper.
  const prismaCli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}
