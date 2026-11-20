import { releaseSuiteLock } from './suite-lock';

/**
 * Releases the suite lock taken in `global-setup.ts`.
 *
 * Jest runs both in the same process, so the connection holding the lock is
 * still open here.
 *
 * This is a tidiness step, not the guarantee. The lock is **session-level**,
 * so PostgreSQL releases it when the connection dies - which covers the cases
 * a teardown cannot: a crash, Ctrl-C, or a killed worker. If this file never
 * ran, the next run would still start cleanly.
 */
export default async function globalTeardown(): Promise<void> {
  await releaseSuiteLock();
}
