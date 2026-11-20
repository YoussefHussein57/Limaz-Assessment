import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { testDatabaseUrl } from './database-url';

/**
 * A PrismaClient pointed at the throwaway test database created by
 * test/global-setup.ts.
 *
 * The pool is deliberately larger than one. A pool of one serialises
 * "concurrent" requests inside the pool itself, so a concurrency test would
 * pass whether or not the mechanism it claims to verify exists (risk R-10).
 * F01 has no concurrency tests yet, but the habit is set here so F03 and F04
 * inherit a pool that cannot silently invalidate them.
 */
export function createTestPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl(), max: 10 }),
  });
}

/**
 * Removes every row, in foreign-key order.
 *
 * `TRUNCATE ... CASCADE` would be shorter, but it would also hide a mistake:
 * if the delete order is wrong, a RESTRICT foreign key makes the test fail
 * loudly, which is exactly the behaviour the schema is supposed to have.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.review.deleteMany();
  await prisma.ruleHit.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.session.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.user.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.company.deleteMany();
}

/**
 * PostgreSQL SQLSTATE codes, asserted by code rather than by message because
 * messages are localised and change between versions.
 */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
} as const;

export interface DatabaseRejection {
  /** The PostgreSQL SQLSTATE, for example `23505`. */
  code: string;
  /** The constraint that rejected the write, for example `expenses_id_companyId_key`. */
  constraint: string | undefined;
}

/**
 * Runs `operation`, expecting the database to reject it, and reports which
 * SQLSTATE and which constraint did the rejecting.
 *
 * Prisma translates driver errors into its own `P` codes - P2002 for unique,
 * P2003 for foreign key, P2039 for everything else including CHECK - which is
 * too coarse here: P2039 cannot distinguish a CHECK violation from an
 * unrelated database error. The driver adapter keeps the original SQLSTATE
 * and constraint name under `meta.driverAdapterError.cause`, so that is what
 * these tests assert on.
 *
 * Returning the constraint name matters: "some foreign key rejected this" is
 * a much weaker statement than "the composite foreign key that binds a review
 * to its expense's tenant rejected this".
 */
export async function expectPgError(operation: () => Promise<unknown>): Promise<DatabaseRejection> {
  try {
    await operation();
  } catch (error: unknown) {
    const err = error as {
      code?: string;
      message?: string;
      meta?: {
        driverAdapterError?: {
          cause?: {
            originalCode?: string;
            code?: string;
            originalMessage?: string;
            message?: string;
            constraint?: { index?: string };
          };
        };
      };
    };

    const cause = err.meta?.driverAdapterError?.cause;
    const message = cause?.originalMessage ?? cause?.message ?? err.message ?? '';

    const code =
      firstSqlState(cause?.originalCode) ??
      firstSqlState(cause?.code) ??
      firstSqlState(err.code) ??
      message.match(/\b(\d{5})\b/)?.[1];

    if (!code) {
      // Keep the original: without it, a genuinely unexpected failure would be
      // reported only as "no SQLSTATE", hiding what actually went wrong.
      throw new Error(
        `The write was rejected, but no SQLSTATE could be read from it:\n${message}`,
        { cause: error },
      );
    }

    return {
      code,
      // Unique and foreign-key violations carry the name structurally; CHECK
      // violations only name it in the message.
      constraint: cause?.constraint?.index ?? message.match(/constraint "([^"]+)"/)?.[1],
    };
  }

  throw new Error('Expected the database to reject this write, but it succeeded');
}

function firstSqlState(value: string | undefined): string | undefined {
  return value && /^\d{5}$/.test(value) ? value : undefined;
}
