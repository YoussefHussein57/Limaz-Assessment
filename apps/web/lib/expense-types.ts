/**
 * The shapes the API returns, as this application reads them.
 *
 * Hand-written rather than imported from the API package, and that is a
 * deliberate trade. Importing `@limaz/api`'s types would couple the browser
 * bundle to a NestJS/Prisma module graph and make a server-only type one
 * careless import away from the client. Writing them here means they can
 * DRIFT from the server - which is why the contract tests in the API assert
 * the response shape, and why every field below is optional-free: a missing
 * one is a type error at the call site rather than an `undefined` rendered as
 * blank.
 */

export type ExpenseDecision = 'APPROVE' | 'REVIEW' | 'REJECT';
export type ExpenseStatus = 'APPROVED' | 'REJECTED' | 'PENDING_REVIEW';
export type ReviewState = 'OPEN' | 'RESOLVED';
export type ReviewOutcome = 'APPROVED' | 'REJECTED';

/**
 * Known rule codes.
 *
 * `(string & {})` keeps the union open: a code this build has never heard of
 * still typechecks and still reaches the UI, where it renders through a
 * documented fallback instead of crashing the page (F06-T31). Closing the
 * union would turn a new backend rule into a frontend deployment blocker.
 */
export type RuleCode = 'AMOUNT_LIMIT' | 'FREQUENCY' | 'BLOCKED_CATEGORY' | (string & {});

export interface ExpenseListItem {
  id: string;
  externalId: string;
  employeeId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  category: string;
  spentAt: string;
  receivedAt: string;
  decision: ExpenseDecision;
  status: ExpenseStatus;
  reasonCodes: RuleCode[];
  reviewState: ReviewState | null;
}

export interface ExpenseReason {
  code: RuleCode;
  decision: ExpenseDecision;
  /** Rule-specific evidence. Read defensively - see `expense-reasons.ts`. */
  detail: unknown;
}

export interface ExpenseReview {
  id: string;
  state: ReviewState;
  createdAt: string;
  outcome: ReviewOutcome | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; displayName: string } | null;
}

export interface ExpenseDetail {
  id: string;
  externalId: string;
  employeeId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  category: string;
  spentAt: string;
  receivedAt: string;
  decision: ExpenseDecision;
  status: ExpenseStatus;
  reasons: ExpenseReason[];
  policySnapshot: unknown;
  review: ExpenseReview | null;
}

export interface ExpensePage {
  items: ExpenseListItem[];
  nextCursor: string | null;
}

export interface DashboardSummary {
  total: number;
  byStatus: Record<ExpenseStatus, number>;
  flagged: {
    total: number;
    pending: number;
    approvedByManager: number;
    rejectedByManager: number;
  };
  amounts: { currency: string; totalMinor: number }[];
  generatedAt: string;
}

/** The policy settings an expense was judged against, captured at decision time. */
export interface PolicySnapshot {
  autoApproveLimitMinor: number;
  frequencyMaxCount: number;
  frequencyWindowMinutes: number;
  blockedCategories: string[];
}

/**
 * Reads a policy snapshot defensively.
 *
 * The column is `Json`, so the only honest typing is `unknown`. Historical
 * rows were written by whatever the application was at the time, and a
 * snapshot from before a field existed will not have it. Returning null for
 * anything that does not match means the detail page shows "not recorded"
 * rather than `undefined` where a limit should be.
 */
export function readPolicySnapshot(value: unknown): PolicySnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const raw = value as Record<string, unknown>;

  if (
    typeof raw.autoApproveLimitMinor !== 'number' ||
    typeof raw.frequencyMaxCount !== 'number' ||
    typeof raw.frequencyWindowMinutes !== 'number' ||
    !Array.isArray(raw.blockedCategories)
  ) {
    return null;
  }

  return {
    autoApproveLimitMinor: raw.autoApproveLimitMinor,
    frequencyMaxCount: raw.frequencyMaxCount,
    frequencyWindowMinutes: raw.frequencyWindowMinutes,
    blockedCategories: raw.blockedCategories.filter(
      (entry): entry is string => typeof entry === 'string',
    ),
  };
}
