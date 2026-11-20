/**
 * Deciding whether a failed INSERT was OUR uniqueness conflict.
 *
 * Getting this wrong in the permissive direction is the dangerous case: a
 * `rule_hits_expenseId_ruleCode_key` violation, or an unrelated unique index
 * added years from now, would be reported to the caller as "this expense
 * already exists" - a 200 or a 409 describing a row that was never written.
 * The caller stops retrying, and the expense is simply lost.
 *
 * So the question is never "did a unique constraint fire?" but "did
 * `expenses_companyId_externalId_key` fire?" (test F03-T24).
 *
 * WHY PRISMA'S OWN CODE IS NOT ENOUGH
 *
 * Prisma reports every unique violation as `P2002` and attaches `meta.target`,
 * which is sometimes the constraint name and sometimes a list of column names,
 * depending on the database and the driver. The driver adapter keeps the real
 * PostgreSQL error underneath, including the SQLSTATE and the index that
 * rejected the write. Both are read here, and the constraint name is required
 * before a conflict is claimed - the same approach the F01 constraint tests
 * use, for the same reason.
 */

/** The constraint that enforces tenant-scoped idempotency (ADR-001). */
export const EXPENSE_IDEMPOTENCY_CONSTRAINT = 'expenses_companyId_externalId_key';

/** PostgreSQL `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

interface PrismaDriverError {
  code?: string;
  message?: string;
  meta?: {
    target?: unknown;
    driverAdapterError?: {
      cause?: {
        originalCode?: string;
        code?: string;
        originalMessage?: string;
        message?: string;
        constraint?: { index?: string } | string;
      };
    };
  };
}

/**
 * True only for a unique violation on the expense idempotency constraint.
 *
 * Deliberately conservative: an error that cannot be positively identified
 * falls through as `false` and becomes a 500. A lost expense that the caller
 * is told about is recoverable; one the caller believes was accepted is not.
 */
export function isExpenseIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as PrismaDriverError;
  const cause = err.meta?.driverAdapterError?.cause;

  const sqlState = firstSqlState(cause?.originalCode) ?? firstSqlState(cause?.code);
  const isUnique = sqlState === UNIQUE_VIOLATION || err.code === 'P2002';

  if (!isUnique) {
    return false;
  }

  return namesIdempotencyConstraint(cause?.constraint) || targetNamesConstraint(err.meta?.target);
}

function namesIdempotencyConstraint(constraint: { index?: string } | string | undefined): boolean {
  if (typeof constraint === 'string') {
    return constraint === EXPENSE_IDEMPOTENCY_CONSTRAINT;
  }

  return constraint?.index === EXPENSE_IDEMPOTENCY_CONSTRAINT;
}

/**
 * Prisma's `meta.target` fallback.
 *
 * It can be the constraint name, or the column list `['companyId',
 * 'externalId']`. The column list is accepted only when it is EXACTLY those
 * two columns - a superset or a subset is a different constraint.
 */
function targetNamesConstraint(target: unknown): boolean {
  if (typeof target === 'string') {
    return target === EXPENSE_IDEMPOTENCY_CONSTRAINT;
  }

  if (Array.isArray(target)) {
    const columns = target.filter((item): item is string => typeof item === 'string');

    return columns.length === 2 && columns.includes('companyId') && columns.includes('externalId');
  }

  return false;
}

/** The driver sometimes reports several codes; the first five-digit one wins. */
function firstSqlState(value: string | undefined): string | undefined {
  return value?.match(/\b(\d{5})\b/u)?.[1];
}
