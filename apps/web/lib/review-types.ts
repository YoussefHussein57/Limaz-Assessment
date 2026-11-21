import type {
  ExpenseDecision,
  ExpenseStatus,
  ReviewOutcome,
  ReviewState,
  RuleCode,
} from './expense-types';

/**
 * The review shapes the API returns, as this application reads them.
 *
 * Hand-written for the same reason the expense shapes are: importing the
 * API's types would couple the browser bundle to a NestJS and Prisma module
 * graph. The API's own contract tests are what keep the two honest.
 */

/** The expense a review is about, as the review endpoints return it. */
export interface ReviewExpense {
  id: string;
  externalId: string;
  employeeId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  category: string;
  spentAt: string;
  /** The ORIGINAL policy decision. Always REVIEW for a review's expense. */
  decision: ExpenseDecision;
  /** The CURRENT status. Resolving the review changes this. */
  status: ExpenseStatus;
}

/** Null while OPEN; all three fields together once RESOLVED. */
export interface ReviewResolution {
  outcome: ReviewOutcome;
  resolvedAt: string;
  resolvedBy: { id: string; displayName: string };
}

export interface ReviewSummary {
  id: string;
  state: ReviewState;
  createdAt: string;
  expense: ReviewExpense;
  /** Codes only in the list; the evidence is on the detail route. */
  reasonCodes: RuleCode[];
  resolution: ReviewResolution | null;
}

export interface ReviewDetail {
  id: string;
  state: ReviewState;
  createdAt: string;
  expense: ReviewExpense;
  reasons: { code: RuleCode; decision: ExpenseDecision; detail: unknown }[];
  policySnapshot: unknown;
  receivedAt: string;
  resolution: ReviewResolution | null;
}

export interface ReviewPage {
  items: ReviewSummary[];
  nextCursor: string | null;
}

/** What the resolve endpoint accepts. */
export type ReviewDecision = 'APPROVE' | 'REJECT';

/** The company policy a manager reads and edits. */
export interface CompanyPolicy {
  autoApproveLimitMinor: number;
  frequencyMaxCount: number;
  frequencyWindowMinutes: number;
  blockedCategories: string[];
  currency: string;
  updatedAt: string;
}

/** The fields a manager may change. All optional - the API takes a PATCH. */
export interface PolicyPatch {
  autoApproveLimitMinor?: number;
  frequencyMaxCount?: number;
  frequencyWindowMinutes?: number;
  blockedCategories?: string[];
}
