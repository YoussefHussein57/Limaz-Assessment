import type { Expense, Review, RuleHit, User } from '@prisma/client';

/**
 * The public shapes for the review endpoints.
 *
 * Built explicitly from rows rather than returned from them. A spread of a
 * Prisma model publishes every column added in future - `payloadHash` among
 * them, which would let a caller probe whether a guessed payload matches an
 * expense (F03-T14c), and `resolvedByUserId` joined to a full `User` would
 * publish an email address nobody asked for.
 */

/** Enough to render a row in a list. Deliberately not the whole expense. */
export interface ReviewSummary {
  readonly id: string;
  readonly state: Review['state'];
  readonly createdAt: string;
  readonly expense: {
    readonly id: string;
    readonly externalId: string;
    readonly employeeId: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly merchant: string;
    readonly category: string;
    readonly spentAt: string;
    /** The ORIGINAL policy decision. Always REVIEW for a review's expense. */
    readonly decision: Expense['decision'];
    /** The CURRENT status, which a resolution changes. */
    readonly status: Expense['status'];
  };
  /** Rule codes only in the list; the full evidence is on the detail route. */
  readonly reasonCodes: readonly RuleHit['ruleCode'][];
  readonly resolution: ReviewResolution | null;
}

/** The detail view adds the evidence and the policy snapshot. */
export interface ReviewDetail extends Omit<ReviewSummary, 'reasonCodes'> {
  readonly reasons: readonly {
    readonly code: RuleHit['ruleCode'];
    readonly decision: RuleHit['decision'];
    readonly detail: unknown;
  }[];
  /** What the expense was judged against, captured at decision time (A7). */
  readonly policySnapshot: unknown;
  readonly receivedAt: string;
}

/** Null while OPEN; all three fields together once RESOLVED. */
export interface ReviewResolution {
  readonly outcome: NonNullable<Review['outcome']>;
  readonly resolvedAt: string;
  readonly resolvedBy: {
    readonly id: string;
    /** The name only. An email address is not needed to show who acted. */
    readonly displayName: string;
  };
}

export interface ReviewPage {
  readonly items: readonly ReviewSummary[];
  /**
   * Opaque. Pass it back as `cursor` for the next page; `null` means this was
   * the last page.
   */
  readonly nextCursor: string | null;
}

type ReviewRow = Review & {
  expense: Expense & { ruleHits: RuleHit[] };
  resolvedBy: User | null;
};

export function toReviewSummary(row: ReviewRow): ReviewSummary {
  return {
    id: row.id,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    expense: {
      id: row.expense.id,
      externalId: row.expense.externalId,
      employeeId: row.expense.employeeId,
      amountMinor: row.expense.amountMinor,
      currency: row.expense.currency,
      merchant: row.expense.merchant,
      category: row.expense.category,
      spentAt: row.expense.spentAt.toISOString(),
      decision: row.expense.decision,
      status: row.expense.status,
    },
    reasonCodes: sortedHits(row.expense.ruleHits).map((hit) => hit.ruleCode),
    resolution: toResolution(row),
  };
}

export function toReviewDetail(row: ReviewRow): ReviewDetail {
  const summary = toReviewSummary(row);
  const { reasonCodes: _ignored, ...rest } = summary;

  return {
    ...rest,
    reasons: sortedHits(row.expense.ruleHits).map((hit) => ({
      code: hit.ruleCode,
      decision: hit.decision,
      detail: hit.detail,
    })),
    policySnapshot: row.expense.policySnapshot,
    receivedAt: row.expense.receivedAt.toISOString(),
  };
}

export function toResolution(row: ReviewRow): ReviewResolution | null {
  // The CHECK constraint makes these three either all null or all set, so one
  // of them is enough to decide - but all three are tested, because relying
  // on a database constraint to hold while narrowing a type is how a null
  // reaches a caller.
  if (row.state !== 'RESOLVED' || !row.outcome || !row.resolvedAt || !row.resolvedBy) {
    return null;
  }

  return {
    outcome: row.outcome,
    resolvedAt: row.resolvedAt.toISOString(),
    resolvedBy: { id: row.resolvedBy.id, displayName: row.resolvedBy.displayName },
  };
}

/**
 * Alphabetical by rule code, matching the expense response (F03).
 *
 * Sorted here rather than in SQL deliberately: `ORDER BY "ruleCode"` on a
 * PostgreSQL enum sorts by DECLARATION order - AMOUNT_LIMIT, FREQUENCY,
 * BLOCKED_CATEGORY - which is not the order the contract promises (F04-T36).
 */
function sortedHits(hits: readonly RuleHit[]): RuleHit[] {
  return [...hits].sort((a, b) => a.ruleCode.localeCompare(b.ruleCode));
}
