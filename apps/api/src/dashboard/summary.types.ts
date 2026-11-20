import type { ExpenseStatus } from '@prisma/client';

/**
 * The manager dashboard's aggregate figures.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE NUMBERS MEAN - PRECISELY
 * ---------------------------------------------------------------------------
 *
 * - ALL TIME. There is no date filter, and the labels in the UI say so.
 * - CURRENT STATUS, not the original decision. An expense the policy flagged
 *   and a manager then approved counts as APPROVED. Counting it as pending
 *   would show work that is already done.
 * - ONE CONSISTENT OBSERVATION. Every figure comes from a single `groupBy`,
 *   therefore a single statement, therefore a single MVCC snapshot. The
 *   status counts sum to `total` by construction, not by luck: four separate
 *   `count()` calls would be four snapshots, and a submission landing between
 *   them would produce a dashboard whose parts do not add up.
 * - PER CURRENCY. Monetary totals are never summed across currencies.
 */

/** Counts by current status. Always all three keys, zero included. */
export type StatusCounts = Readonly<Record<ExpenseStatus, number>>;

/**
 * Expenses the POLICY flagged (`decision = REVIEW`), split by what happened
 * next.
 *
 * This is the only place the original decision is used for counting, and it
 * is used to describe the decision itself rather than the outcome: it answers
 * "how much did a human actually have to judge, and which way did it go".
 */
export interface FlaggedBreakdown {
  /** Every expense with `decision = REVIEW`, whatever its status now is. */
  readonly total: number;
  /** Still `PENDING_REVIEW` - nobody has decided yet. */
  readonly pending: number;
  /** Flagged, then APPROVED by a manager. */
  readonly approvedByManager: number;
  /** Flagged, then REJECTED by a manager. */
  readonly rejectedByManager: number;
}

/** A monetary total, in the integer minor units the expense was stored with. */
export interface CurrencyTotal {
  readonly currency: string;
  readonly totalMinor: number;
}

export interface DashboardSummary {
  readonly total: number;
  readonly byStatus: StatusCounts;
  readonly flagged: FlaggedBreakdown;
  /**
   * One entry per currency actually present, ascending by code. Empty for a
   * company with no expenses.
   *
   * Assumption A3 says a company has exactly one currency, so in practice
   * this holds one entry. It is still a LIST, because the aggregate must not
   * depend on that assumption holding: if it ever stopped being true, a
   * single scalar would quietly add riyals to dollars and the dashboard would
   * be wrong without failing.
   */
  readonly amounts: readonly CurrencyTotal[];
  /**
   * When this RESPONSE was built, which is strictly after the snapshot the
   * figures were read from. It is not the snapshot's own timestamp - that is
   * internal to PostgreSQL and is not exposed - so it is named for what it
   * actually is.
   */
  readonly generatedAt: string;
}

/**
 * The categories a company has actually used, for the expense filter.
 *
 * `truncated` is part of the contract rather than an implementation detail:
 * the whole point of this endpoint is that the UI must not present a partial
 * list as the company's complete set (R-29). If the cap is ever reached, the
 * interface has to say so.
 */
export interface CategoryList {
  readonly categories: readonly string[];
  readonly truncated: boolean;
}
