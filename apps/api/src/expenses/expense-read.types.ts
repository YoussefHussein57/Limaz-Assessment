import type { Expense, Review, RuleHit, User } from '@prisma/client';

/**
 * The public shapes for the manager's READ endpoints.
 *
 * Built field by field from rows, never spread from them. The rule is the same
 * one F03 and F05 follow and the reason is specific rather than stylistic:
 * `Expense` carries `payloadHash`, and publishing it would let a caller probe
 * whether a guessed payload matches an expense (F03-T14c). A spread publishes
 * every column added in future, including the next one nobody thought about.
 *
 * `resolvedBy` is narrowed to a display name for the same reason it is in
 * `review.types.ts`: showing who acted does not require publishing their email
 * address.
 */

/** Enough to render one row. Deliberately not the whole expense. */
export interface ExpenseListItem {
  readonly id: string;
  readonly externalId: string;
  readonly employeeId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchant: string;
  readonly category: string;
  readonly spentAt: string;
  readonly receivedAt: string;
  /** The ORIGINAL policy decision. Never changes. */
  readonly decision: Expense['decision'];
  /** The CURRENT status. A manager's resolution changes this and only this. */
  readonly status: Expense['status'];
  /**
   * Rule codes only.
   *
   * The full evidence lives on the detail route. The list does NOT include
   * the rule-hit rows for their detail - it includes them for their codes,
   * which is one extra statement for the whole page rather than one per row.
   */
  readonly reasonCodes: readonly RuleHit['ruleCode'][];
  /** Present only once a review exists AND has been resolved. */
  readonly reviewState: Review['state'] | null;
}

/** The detail view adds the evidence, the snapshot and the human outcome. */
export interface ExpenseDetail extends Omit<ExpenseListItem, 'reasonCodes' | 'reviewState'> {
  readonly reasons: readonly {
    readonly code: RuleHit['ruleCode'];
    readonly decision: RuleHit['decision'];
    readonly detail: unknown;
  }[];
  /** What this expense was judged against, captured at decision time (A7). */
  readonly policySnapshot: unknown;
  readonly review: ExpenseReview | null;
}

/** The review attached to a flagged expense, if one was opened. */
export interface ExpenseReview {
  readonly id: string;
  readonly state: Review['state'];
  readonly createdAt: string;
  /** Null while OPEN; all three together once RESOLVED. */
  readonly outcome: NonNullable<Review['outcome']> | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: { readonly id: string; readonly displayName: string } | null;
}

export interface ExpensePage {
  readonly items: readonly ExpenseListItem[];
  /**
   * Opaque. Pass it back as `cursor` for the next page; `null` means this was
   * the last page.
   */
  readonly nextCursor: string | null;
}

type ListRow = Expense & {
  ruleHits: { ruleCode: RuleHit['ruleCode'] }[];
  review: { state: Review['state'] } | null;
};

type DetailRow = Expense & {
  ruleHits: RuleHit[];
  review: (Review & { resolvedBy: User | null }) | null;
};

export function toExpenseListItem(row: ListRow): ExpenseListItem {
  return {
    id: row.id,
    externalId: row.externalId,
    employeeId: row.employeeId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    merchant: row.merchant,
    category: row.category,
    spentAt: row.spentAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    decision: row.decision,
    status: row.status,
    reasonCodes: sortedCodes(row.ruleHits),
    reviewState: row.review?.state ?? null,
  };
}

export function toExpenseDetail(row: DetailRow): ExpenseDetail {
  return {
    id: row.id,
    externalId: row.externalId,
    employeeId: row.employeeId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    merchant: row.merchant,
    category: row.category,
    spentAt: row.spentAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    decision: row.decision,
    status: row.status,
    reasons: [...row.ruleHits]
      .sort((a, b) => a.ruleCode.localeCompare(b.ruleCode))
      .map((hit) => ({ code: hit.ruleCode, decision: hit.decision, detail: hit.detail })),
    policySnapshot: row.policySnapshot,
    review: toExpenseReview(row.review),
  };
}

function toExpenseReview(review: DetailRow['review']): ExpenseReview | null {
  if (!review) {
    return null;
  }

  const open = {
    id: review.id,
    state: review.state,
    createdAt: review.createdAt.toISOString(),
    outcome: null,
    resolvedAt: null,
    resolvedBy: null,
  } as const;

  // The CHECK constraint makes outcome, resolvedAt and resolvedByUserId either
  // all null or all set, so one test would do - but all three are checked,
  // because relying on a database constraint to hold while narrowing a type is
  // how a null reaches a caller. Checking them in the `if` rather than in a
  // boolean const is what lets the compiler narrow them below.
  if (!review.outcome || !review.resolvedAt || !review.resolvedBy || review.state !== 'RESOLVED') {
    return open;
  }

  return {
    ...open,
    outcome: review.outcome,
    resolvedAt: review.resolvedAt.toISOString(),
    resolvedBy: { id: review.resolvedBy.id, displayName: review.resolvedBy.displayName },
  };
}

/**
 * Alphabetical by rule code, matching the submission response (F03) and the
 * review endpoints (F05).
 *
 * Sorted in TypeScript rather than in SQL deliberately: `ORDER BY "ruleCode"`
 * on a PostgreSQL enum sorts by DECLARATION order - AMOUNT_LIMIT, FREQUENCY,
 * BLOCKED_CATEGORY - which is not the order the contract promises (F04-T36).
 */
function sortedCodes(hits: readonly { ruleCode: RuleHit['ruleCode'] }[]): RuleHit['ruleCode'][] {
  return [...hits].map((hit) => hit.ruleCode).sort((a, b) => a.localeCompare(b));
}
