import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Serialisation for one (company, employee) inside one transaction.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN INJECTED DEPENDENCY RATHER THAN A LINE OF SQL
 * ---------------------------------------------------------------------------
 *
 * Because a concurrency test that cannot remove the mechanism it claims to
 * verify is not evidence. The frequency negative control has to run the exact
 * same production code path with the lock absent, and show the rule silently
 * failing - otherwise "the lock works" is an assertion about a test that would
 * pass either way.
 *
 * The seam is deliberately narrow:
 *
 *  - There is NO environment variable and NO configuration flag. The only way
 *    to substitute this is Nest's testing `overrideProvider`, which a running
 *    application has no access to. A flag would eventually be set in
 *    production by someone debugging something else, and turning off a
 *    correctness guarantee is a worse outcome than the problem it solves.
 *  - `ExpensesModule.withEvaluator()` always binds the real implementation.
 *    Nothing has to be remembered.
 */
export interface FrequencyLock {
  acquire(tx: Prisma.TransactionClient, companyId: string, employeeId: string): Promise<void>;
}

/** Injection token. A symbol, so no request payload could ever collide. */
export const FREQUENCY_LOCK = Symbol('limaz.frequencyLock');

/**
 * The production implementation: a PostgreSQL transaction-scoped advisory
 * lock (ADR-007).
 *
 * TRANSACTION-SCOPED, never session-scoped. It is released by COMMIT or
 * ROLLBACK, including a rollback caused by the process dying mid-request. The
 * session variant (`pg_advisory_lock`) is released only by an explicit
 * unlock, so a crash would leak it onto a pooled connection and poison that
 * connection for every later request - a latent outage under PgBouncer.
 *
 * TWO ARGUMENTS, not one concatenated string. `hashtext(a || ':' || b)` gives
 * a 32-bit key space, where the birthday bound puts a collision at roughly
 * 77,000 distinct keys, and needs a separator that cannot occur in an
 * employeeId. Two independent 32-bit arguments give 2^64 and no separator
 * problem.
 *
 * A collision would only make two unrelated pairs wait on each other. It
 * cannot produce a wrong decision, because every query inside the lock still
 * filters by the real companyId and employeeId - the lock decides who waits,
 * never who sees what (risk R-09).
 */
@Injectable()
export class AdvisoryFrequencyLock implements FrequencyLock {
  async acquire(
    tx: Prisma.TransactionClient,
    companyId: string,
    employeeId: string,
  ): Promise<void> {
    // Parameterised. Both values are caller-influenced and are never
    // interpolated into SQL text.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${companyId}), hashtext(${employeeId}))`;
  }
}
