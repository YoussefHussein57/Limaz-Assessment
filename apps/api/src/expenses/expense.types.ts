import type { Expense, RuleHit } from '@prisma/client';

/**
 * The public shape of a submitted expense.
 *
 * Built explicitly from the row rather than returned from it. A spread of the
 * Prisma model would publish every column added in future - `payloadHash`
 * among them, which would hand a caller the ability to probe whether a given
 * payload matches an expense they cannot otherwise read.
 */
export interface ExpenseResponse {
  readonly id: string;
  readonly externalId: string;
  readonly employeeId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchant: string;
  readonly category: string;
  readonly spentAt: string;
  readonly receivedAt: string;
  readonly decision: Expense['decision'];
  readonly status: Expense['status'];
  /** Every rule that fired, which is what the assessment calls the reasons. */
  readonly reasons: readonly ExpenseReason[];
  /**
   * True when this response describes an expense that already existed.
   *
   * Explicit rather than inferred from the status code, so a caller logging
   * only the body can still tell a fresh submission from a replayed one.
   */
  readonly duplicate: boolean;
}

export interface ExpenseReason {
  readonly code: RuleHit['ruleCode'];
  readonly decision: RuleHit['decision'];
  readonly detail: unknown;
}

export function toExpenseResponse(
  expense: Expense,
  ruleHits: readonly RuleHit[],
  duplicate: boolean,
): ExpenseResponse {
  return {
    id: expense.id,
    externalId: expense.externalId,
    employeeId: expense.employeeId,
    amountMinor: expense.amountMinor,
    currency: expense.currency,
    merchant: expense.merchant,
    category: expense.category,
    spentAt: expense.spentAt.toISOString(),
    receivedAt: expense.receivedAt.toISOString(),
    decision: expense.decision,
    status: expense.status,
    // Sorted, so two responses describing the same expense are byte-identical
    // regardless of the order the rows came back in.
    reasons: [...ruleHits]
      .sort((a, b) => a.ruleCode.localeCompare(b.ruleCode))
      .map((hit) => ({ code: hit.ruleCode, decision: hit.decision, detail: hit.detail })),
    duplicate,
  };
}
