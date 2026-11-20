import type { ExpenseDecision, Policy, Prisma, RuleCode } from '@prisma/client';
import type { NormalisedExpense } from './canonical-payload';

/**
 * The seam between F03 and F04.
 *
 * F03 owns the ORCHESTRATION: validation, canonicalisation, idempotency, the
 * transaction, the advisory lock, conflict classification and persistence.
 * F04 owns the DECISION: the frequency count, the three rules, and precedence.
 *
 * Why a port rather than a stub implementation that returns APPROVE:
 *
 * The `expenses_decision_status_check` constraint makes a placeholder decision
 * physically unstorable, which is the right design and also closes the easy
 * shortcut. More importantly, an endpoint that answers APPROVE without
 * evaluating the frequency rule is not "incomplete" - it is WRONG, and wrong
 * in the direction that approves spending which policy says to review. The
 * assessment forbids it and it would be the wrong call anyway.
 *
 * So in F03 no production implementation of this interface exists, and
 * `ExpensesModule` is registered only inside test modules. The deployed
 * application has no expense endpoint at all until F04 binds the real
 * evaluator. One line in app.module.ts turns it on; nothing has to be undone,
 * and no row ever carried a decision that was not genuinely evaluated.
 */

/** What the evaluator is told. Everything comes from inside the transaction. */
export interface PolicyEvaluationInput {
  /** The normalised expense, exactly as it will be stored. */
  readonly expense: NormalisedExpense;
  /** The company's policy row, read inside the same transaction. */
  readonly policy: Policy;
  /**
   * The company this expense belongs to, from the authenticated API key and
   * from nowhere else.
   */
  readonly companyId: string;
  /**
   * The transaction the submission is running in.
   *
   * Passed explicitly rather than letting the evaluator reach for the global
   * client, because a frequency count issued OUTSIDE this transaction would
   * not be protected by the advisory lock and would see a different snapshot -
   * the exact bug ADR-007 is written to prevent. Making it a parameter means
   * the correct client is the one that is already in hand.
   */
  readonly tx: Prisma.TransactionClient;
}

/** One rule's verdict, before precedence is applied. */
export interface RuleHitResult {
  readonly ruleCode: RuleCode;
  readonly decision: ExpenseDecision;
  /** Rule-specific evidence: the limit and the amount, or the window and count. */
  readonly detail: Record<string, unknown>;
}

/** The outcome, after precedence. */
export interface PolicyEvaluationResult {
  readonly decision: ExpenseDecision;
  /** Every rule that fired. An APPROVE with no hits is a legitimate result. */
  readonly ruleHits: readonly RuleHitResult[];
}

/**
 * Evaluates one expense against one policy.
 *
 * Called INSIDE the submission transaction, after the advisory lock is held,
 * so an implementation may safely count sibling expenses: no competitor for
 * the same (company, employee) can commit between the count and the insert
 * (ADR-007). That is the whole reason the lock is taken in F03 even though
 * idempotency does not need it - the transaction's statement order is built
 * once, with the F04 implementation's requirement already satisfied.
 */
export interface PolicyEvaluator {
  evaluate(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult>;
}

/** Injection token. A string token because the interface is erased at runtime. */
export const POLICY_EVALUATOR = Symbol('limaz.policyEvaluator');
