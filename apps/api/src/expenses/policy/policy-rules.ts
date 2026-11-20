import type { ExpenseDecision, Policy } from '@prisma/client';
import { normaliseCategory } from '../canonical-payload';
import type { PolicyEvaluationResult, RuleHitResult } from '../policy-evaluator.port';

/**
 * The three policy rules, as pure functions.
 *
 * NOTHING HERE TOUCHES THE DATABASE. No Prisma client, no transaction, no
 * clock, no randomness. Given the same inputs this file always produces the
 * same output, which is what lets the fifteen rule tests run with no database
 * at all and cover every boundary exhaustively instead of sampling.
 *
 * The impure part - counting how many expenses already sit in the window - is
 * `PolicyEngineEvaluator`, which does that one query and then calls
 * `evaluateRules` below. The split is the whole architecture:
 *
 *   policy-rules.ts          decides     (pure)
 *   policy-engine.evaluator  measures    (one COUNT, inside the transaction)
 *   expense-submission       orchestrates (lock, idempotency, writes)
 *
 * Why three small functions rather than one. A single function mixing all
 * three rules means every boundary test exercises all three, so a failure
 * says "something is wrong" rather than naming the rule. Why not strategy
 * classes: a class with one method and no state is a function with ceremony,
 * and the rule set is fixed by the assessment - there is no dispatch to make
 * polymorphic. Why not a configurable rules engine: three fixed rules do not
 * need an expression language, and building one would be inventing a problem.
 */

/** What the rules need. Deliberately not the Prisma row - no `tx`, no ids. */
export interface RuleContext {
  /** Minor units, integer (ADR-005). */
  readonly amountMinor: number;
  /** Already normalised by `normaliseExpense`. */
  readonly category: string;
  /** Existing expenses in the window, PLUS this one (ADR-002). */
  readonly countIncludingCurrent: number;
  readonly policy: Policy;
}

/**
 * Decision strength. An explicit table, not the order the rules happen to run
 * in.
 *
 * Relying on evaluation order means the answer changes if somebody reorders
 * two lines that look independent. With a rank, reordering is provably
 * irrelevant - which is what test F04-T15 asserts.
 */
const RANK: Record<ExpenseDecision, number> = {
  APPROVE: 1,
  REVIEW: 2,
  REJECT: 3,
};

/**
 * Amount limit: REVIEW when the amount is STRICTLY greater than the limit.
 *
 * An amount exactly equal to the limit does not fire. "Auto-approve limit"
 * names the largest amount that is still auto-approved; `>=` would mean the
 * limit is the smallest amount that is not, which is a different rule and an
 * off-by-one a company would notice on every expense priced at the cap.
 *
 * Integer comparison throughout. There is no floating-point arithmetic
 * anywhere in this file (ADR-005).
 */
export function amountLimitRule(context: RuleContext): RuleHitResult | null {
  if (context.amountMinor <= context.policy.autoApproveLimitMinor) {
    return null;
  }

  return {
    ruleCode: 'AMOUNT_LIMIT',
    decision: 'REVIEW',
    // This shape is NOT free. The seed already writes rule hits in exactly
    // this form, so an evaluator producing anything else would make seeded
    // rows and freshly evaluated rows describe the same rule two different
    // ways, and F06 would have to handle both.
    detail: {
      autoApproveLimitMinor: context.policy.autoApproveLimitMinor,
      amountMinor: context.amountMinor,
    },
  };
}

/**
 * Frequency: REVIEW when the count INCLUDING this expense exceeds the limit.
 *
 * With `frequencyMaxCount = 3`, three expenses in the window are fine and the
 * fourth fires - 4 > 3. The current expense is counted exactly once, by the
 * caller adding 1 to the number of rows it found (ADR-002).
 *
 * The window itself is the evaluator's business, because measuring it needs
 * the database. This function only compares two integers.
 */
export function frequencyRule(context: RuleContext): RuleHitResult | null {
  if (context.countIncludingCurrent <= context.policy.frequencyMaxCount) {
    return null;
  }

  return {
    ruleCode: 'FREQUENCY',
    decision: 'REVIEW',
    detail: {
      windowMinutes: context.policy.frequencyWindowMinutes,
      maxCount: context.policy.frequencyMaxCount,
      countIncludingCurrent: context.countIncludingCurrent,
    },
  };
}

/**
 * Blocked category: REJECT when the category is on the company's list.
 *
 * BOTH SIDES ARE NORMALISED BY THE SAME FUNCTION. The expense's category was
 * normalised at submission; each policy entry is normalised here. Without
 * that, a list saved as ` gambling ` from the F08 admin screen would fail to
 * block an expense in `GAMBLING` - a policy rule that looks configured and
 * silently does nothing, which is worse than one that is obviously missing.
 *
 * - Empty list: nothing matches, no hit.
 * - Different casing: matches, both sides uppercased.
 * - Surrounding or repeated whitespace: matches, both sides collapsed.
 * - Equivalent Unicode encodings: match, both sides NFC.
 */
export function blockedCategoryRule(context: RuleContext): RuleHitResult | null {
  const blocked = context.policy.blockedCategories.map(normaliseCategory);

  if (!blocked.includes(context.category)) {
    return null;
  }

  return {
    ruleCode: 'BLOCKED_CATEGORY',
    decision: 'REJECT',
    detail: {
      category: context.category,
      // The policy's own values, not the normalised ones: this is evidence of
      // what the company configured, and it is what the seed records.
      blockedCategories: context.policy.blockedCategories,
    },
  };
}

/**
 * Runs every rule and applies precedence.
 *
 * NO SHORT-CIRCUIT. Even when the blocked-category rule fires and the outcome
 * is already settled as REJECT, the other two still run.
 *
 * The reason is that the decision carries one piece of information and the
 * evaluation carries three. An expense that is over the limit AND in a
 * blocked category AND the fourth in its window has three things wrong with
 * it, and a manager reading it later needs all three. Returning early would
 * discard evidence the API contract promises to deliver, to save two integer
 * comparisons.
 *
 * The fixed order below is alphabetical by rule code, so the order rows are
 * persisted in is deterministic and matches the order the response sorts
 * them into. It carries no precedence meaning - that is `RANK`'s job.
 */
export function evaluateRules(context: RuleContext): PolicyEvaluationResult {
  const ruleHits = [
    amountLimitRule(context),
    blockedCategoryRule(context),
    frequencyRule(context),
  ].filter((hit): hit is RuleHitResult => hit !== null);

  return { decision: decide(ruleHits), ruleHits };
}

/**
 * The strongest triggered decision wins; no triggered rule means APPROVE.
 *
 * REJECT > REVIEW > APPROVE, by rank rather than by position.
 */
export function decide(ruleHits: readonly RuleHitResult[]): ExpenseDecision {
  let decision: ExpenseDecision = 'APPROVE';

  for (const hit of ruleHits) {
    if (RANK[hit.decision] > RANK[decision]) {
      decision = hit.decision;
    }
  }

  return decision;
}
