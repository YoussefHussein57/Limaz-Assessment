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
  try {
    await setUpTestDatabase();
  } catch (error) {
    explain(error);
    throw error;
  }
}

/**
 * Prints what Jest is about to throw away.
 *
 * Jest reports a failing `globalSetup` as:
 *
 *   Error: Jest: Got error running globalSetup - test/global-setup.ts,
 *   reason: [AggregateError]
 *
 * and stops. That is the whole message. An `AggregateError` carries its real
 * causes in `error.errors`, and Jest interpolates the error into a string,
 * which for an AggregateError is just its constructor name - so the one piece
 * of information that identifies the problem is discarded before anybody sees
 * it.
 *
 * `node:pg` raises exactly this shape when a host resolves to several
 * addresses and the connection fails on each: one `AggregateError` wrapping
 * one `ECONNREFUSED` per address. The reader needs those addresses.
 *
 * Found by the F13 QA regression pass, MIN-06. The symptom there was ten
 * minutes spent reconstructing this file by hand to find out what it had been
 * trying to do.
 */
function explain(error: unknown): void {
  const lines = ['', '[global-setup] Test database setup failed. The cause Jest omits:'];

  const describe = (value: unknown, indent: string): void => {
    if (value instanceof Error) {
      lines.push(`${indent}${value.name}: ${value.message}`);

      // `code` is where pg puts ECONNREFUSED and PostgreSQL puts its SQLSTATE,
      // and it is usually the most actionable word in the whole failure.
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string') lines.push(`${indent}  code: ${code}`);

      // `execFileSync` runs `prisma migrate deploy` with `stdio: 'pipe'`, so
      // when a migration fails, the only description of WHY is in these two
      // buffers hanging off the error. The message alone says "Command failed".
      for (const stream of ['stdout', 'stderr'] as const) {
        const captured = (value as unknown as Record<string, unknown>)[stream];
        const text =
          typeof captured === 'string'
            ? captured
            : Buffer.isBuffer(captured)
              ? captured.toString('utf8')
              : '';

        for (const line of text.trim().split('\n')) {
          if (line.trim()) lines.push(`${indent}  ${stream}: ${line.trimEnd()}`);
        }
      }

      // AggregateError.errors, then the `cause` chain. Both are dropped by a
      // plain string interpolation.
      const nested = (value as { errors?: unknown }).errors;
      if (Array.isArray(nested)) {
        for (const inner of nested) describe(inner, `${indent}  `);
      }
      if (value.cause !== undefined) describe(value.cause, `${indent}  `);

      return;
    }

    lines.push(`${indent}${String(value)}`);
  };

  describe(error, '  ');

  // The URL is built from environment variables, so a wrong host or port is a
  // common cause - and it is the one thing the message above may not name.
  // `adminDatabaseUrl()` carries a password, so only the parts that help are
  // printed. Never the whole URL.
  try {
    const url = new URL(adminDatabaseUrl());
    lines.push(`  connecting to: ${url.hostname}:${url.port || 5432}`);
  } catch {
    lines.push('  connecting to: DATABASE_URL could not be parsed');
  }

  lines.push('');
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function setUpTestDatabase(): Promise<void> {
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
