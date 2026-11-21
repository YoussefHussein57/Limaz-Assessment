import type { Policy } from '@prisma/client';

/**
 * The policy as a manager sees it.
 *
 * Built field by field, like every other response in this codebase. The row
 * carries `id` and `companyId`, and neither tells the caller anything they do
 * not already know - they are the company they are signed in as.
 *
 * `currency` is included even though it lives on the COMPANY, not the policy.
 * Without it the UI cannot render `autoApproveLimitMinor` as money at all, and
 * the alternative is a second request to learn one three-letter code.
 */
export interface PolicyView {
  readonly autoApproveLimitMinor: number;
  readonly frequencyMaxCount: number;
  readonly frequencyWindowMinutes: number;
  /** Normalised uppercase, sorted, no duplicates. */
  readonly blockedCategories: readonly string[];
  /** The company's currency, so the limit can be formatted. */
  readonly currency: string;
  /**
   * When this policy was last changed.
   *
   * Shown so a manager can tell whether what they are reading is what they
   * set. It is NOT a version: there is no policy history, and an expense's
   * own snapshot is the only record of what it was judged against (A7).
   */
  readonly updatedAt: string;
}

type PolicyRow = Policy & { company: { currency: string } };

export function toPolicyView(row: PolicyRow): PolicyView {
  return {
    autoApproveLimitMinor: row.autoApproveLimitMinor,
    frequencyMaxCount: row.frequencyMaxCount,
    frequencyWindowMinutes: row.frequencyWindowMinutes,
    // Sorted on the way out, so two responses describing the same policy are
    // byte-identical regardless of the order the array was stored in.
    blockedCategories: [...row.blockedCategories].sort((a, b) => a.localeCompare(b)),
    currency: row.company.currency,
    updatedAt: row.updatedAt.toISOString(),
  };
}
