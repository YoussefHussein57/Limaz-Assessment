import { Client } from 'pg';
import { adminDatabaseUrl, TEST_DATABASE_NAME } from './database-url';

/**
 * One test run at a time against `limaz_test`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `globalSetup` does `DROP DATABASE ... WITH (FORCE)` and then `CREATE
 * DATABASE`. Two runs doing that at the same moment is not a race that
 * produces a slightly wrong result - the second one **deletes the first one's
 * database out from under its workers**, and the first run fails with errors
 * that point nowhere near the cause.
 *
 * That happened during F06 verification: `scripts/verify-f02.sh` runs
 * `npm test` internally, and it was started while a separate `npm test` was
 * already running. The script reported `F02-jest suite failed`. Run on its
 * own, the same command passed 32/32. Nothing was wrong with the code; the
 * two runs were deleting each other's database (AI_LOG 36).
 *
 * ---------------------------------------------------------------------------
 * WHY A POSTGRESQL ADVISORY LOCK AND NOT A LOCK FILE
 * ---------------------------------------------------------------------------
 *
 * A lock file has to be cleaned up, and a killed run leaves a stale one behind
 * - so the guard then needs liveness checks on a recorded pid, which is a
 * second thing to get wrong.
 *
 * A **session-level** advisory lock is held by the connection, and PostgreSQL
 * releases it when that connection dies, however it dies: a clean teardown, a
 * crash, Ctrl-C, or the whole machine going away. There is no stale state to
 * clean up and nothing to time out.
 *
 * It is the same mechanism F04 uses for the frequency rule, applied to a
 * different resource - and it is deliberately a DIFFERENT lock key space from
 * the application's, because these two must never block each other.
 *
 * The connection is opened against the `postgres` maintenance database, not
 * `limaz_test`: the lock has to survive `limaz_test` being dropped and
 * recreated, which is the very operation it protects.
 */

/**
 * The two 32-bit halves of the lock key.
 *
 * Literal numbers rather than `hashtext()`, so the key is visible in
 * `pg_locks` without having to compute it, and cannot change if PostgreSQL's
 * hash implementation ever does.
 */
const LOCK_NAMESPACE = 0x4c_49_4d_41 | 0; // "LIMA"
const LOCK_RESOURCE = 0x5a_54_53_54 | 0; // "ZTST"

interface SuiteLock {
  client: Client;
}

/**
 * Stored on `globalThis` because Jest runs `globalSetup` and `globalTeardown`
 * in the SAME process, but as two separate module loads. A module-level
 * variable would not be shared between them; this is the documented way to
 * hand a resource from one to the other.
 */
const HANDLE = Symbol.for('limaz.test.suiteLock');

interface LockCarrier {
  [HANDLE]?: SuiteLock;
}

/**
 * How long to keep trying before refusing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT ZERO, WHICH IS WHAT IT USED TO BE
 * ---------------------------------------------------------------------------
 *
 * `pg_try_advisory_lock` answers immediately, which is right for the case this
 * guard was built for: two runs genuinely active at once. It is WRONG for
 * runs that are merely ADJACENT.
 *
 * The acceptance scripts each invoke `npm test` internally, and they are meant
 * to be run one after another. When Jest exits, PostgreSQL has not necessarily
 * noticed yet - the TCP connection is closed by the operating system a moment
 * later, and the advisory lock is released then. So the next script's run can
 * arrive while the previous one's connection is still, briefly, alive.
 *
 * That is exactly what happened in F13: `verify-f00` and `verify-f01` passed,
 * `verify-f02` reported `F02-jest suite failed`, and the same suite passed
 * 617/617 on its own seconds later. The holder was pid 201, which no longer
 * existed by the time anybody looked (AI_LOG 62).
 *
 * A bounded wait tells the two cases apart. A connection being reaped frees
 * the lock within a second or so; a genuinely concurrent run is still holding
 * it thirty seconds later, and the refusal below still names its pid.
 */
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 500;

export async function acquireSuiteLock(): Promise<void> {
  const client = new Client({ connectionString: adminDatabaseUrl() });
  await client.connect();

  const deadline = Date.now() + LOCK_WAIT_MS;
  let locked: boolean;
  let waited = false;

  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_NAMESPACE, LOCK_RESOURCE],
    );

    locked = result.rows[0]?.locked === true;

    if (locked || Date.now() >= deadline) {
      break;
    }

    if (!waited) {
      waited = true;
      process.stdout.write(
        `[suite-lock] ${TEST_DATABASE_NAME} is held; waiting up to ${LOCK_WAIT_MS / 1_000}s ` +
          'for the previous run to release it.\n',
      );
    }

    // `pg_try_advisory_lock` is retried rather than switching to the blocking
    // `pg_advisory_lock`, so the refusal below can still report WHO holds it.
    // A blocking wait would simply hang with no diagnosis.
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }

  if (!locked) {
    // Who is holding it, so the message names the problem rather than
    // describing it. Best-effort: if this query fails the refusal still
    // stands.
    let holder = 'another process';

    try {
      const owner = await client.query<{ pid: number; query: string }>(
        `SELECT a.pid, a.query
           FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory'
            AND l.classid = $1::int
            AND l.objid   = $2::int
            AND l.granted
          LIMIT 1`,
        [LOCK_NAMESPACE, LOCK_RESOURCE],
      );

      if (owner.rows[0]) {
        holder = `pid ${owner.rows[0].pid}`;
      }
    } catch {
      // Keep the generic description.
    }

    await client.end();

    throw new Error(
      [
        '',
        '================================================================',
        ` Another test run already owns ${TEST_DATABASE_NAME} (${holder}).`,
        '================================================================',
        '',
        ' This run would DROP and CREATE that database while the other one',
        ' is using it, which breaks both. Refusing to start.',
        '',
        ` Waited ${LOCK_WAIT_MS / 1_000}s for it to be released, so this is not`,
        ' a connection that was merely on its way out.',
        '',
        ' Run verification commands ONE AT A TIME. In particular,',
        ' scripts/verify-f0*.sh invoke `npm test` internally, so none of',
        ' them may overlap with each other or with a direct `npm test`.',
        '',
        ' If you are certain no test run is active, that connection was',
        ' abandoned rather than closed. PostgreSQL frees the lock when the',
        ' connection ends, so close it:',
        '',
        `   docker compose exec db psql -U limaz -d postgres \\`,
        `     -c "SELECT pg_terminate_backend(${holder.replace(/\D/gu, '') || '<pid>'})"`,
        '',
        ' See docs/testing/verification-order.md.',
        '',
      ].join('\n'),
    );
  }

  (globalThis as LockCarrier)[HANDLE] = { client };
}

export async function releaseSuiteLock(): Promise<void> {
  const carrier = globalThis as LockCarrier;
  const held = carrier[HANDLE];

  if (!held) {
    return;
  }

  delete carrier[HANDLE];

  try {
    // Explicit, though ending the connection would release it anyway. Being
    // explicit means `pg_locks` is clean even if the pool lingers.
    await held.client.query('SELECT pg_advisory_unlock($1, $2)', [
      LOCK_NAMESPACE,
      LOCK_RESOURCE,
    ]);
  } finally {
    await held.client.end();
  }
}
