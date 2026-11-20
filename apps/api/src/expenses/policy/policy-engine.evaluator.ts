import { Injectable } from '@nestjs/common';
import type {
  PolicyEvaluationInput,
  PolicyEvaluationResult,
  PolicyEvaluator,
} from '../policy-evaluator.port';
import { evaluateRules } from './policy-rules';

/**
 * The real policy evaluator - the implementation F03 left a hole for.
 *
 * It does exactly one impure thing: count the expenses already inside this
 * expense's frequency window. Everything else is delegated to the pure rules.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COUNT IS SAFE HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * This method runs INSIDE the submission transaction, after
 * `pg_advisory_xact_lock(companyId, employeeId)` has been granted. Both facts
 * are load-bearing (ADR-007):
 *
 *  - Under READ COMMITTED each statement takes a FRESH snapshot. Because the
 *    lock was taken first, the count below snapshots after the lock is held,
 *    so it sees every competitor for this employee that has already committed.
 *  - The same lock is still held when the INSERT happens, so no competitor can
 *    commit between the count and the write.
 *
 * Together those give "read the count, decide, write" the serialisation a
 * unique constraint cannot provide - because the invariant is a count, not a
 * uniqueness.
 *
 * `input.tx` is used, never the global client. A count issued outside this
 * transaction would be protected by neither of the above and would silently
 * under-count under concurrency: the frequency rule would simply stop firing,
 * with no error anywhere.
 */
@Injectable()
export class PolicyEngineEvaluator implements PolicyEvaluator {
  async evaluate(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult> {
    const { expense, policy, companyId, tx } = input;

    // The window is BACKWARD-LOOKING and both ends are inclusive (ADR-002):
    //
    //     [spentAt - frequencyWindowMinutes, spentAt]
    //
    // Measured on `spentAt`, not on arrival time, because the rule describes
    // employee behaviour. A client queue that stalls and then flushes ten
    // expenses would otherwise place all ten in one window and fire the rule
    // on behaviour that never happened.
    const windowStart = new Date(
      expense.spentAt.getTime() - policy.frequencyWindowMinutes * 60_000,
    );

    const existing = await tx.expense.count({
      where: {
        // From the authenticated API key, never from the request body.
        companyId,
        // Exactly as submitted. Identifiers are compared exactly - normalising
        // one would merge two employees into a single frequency window.
        employeeId: expense.employeeId,
        spentAt: { gte: windowStart, lte: expense.spentAt },
        // Deliberately NO filter on `decision` or `status` (assumption A2).
        // A rejected expense still happened; the rule measures behaviour, not
        // approvals. Filtering them out would let an employee reset their own
        // window by submitting something that gets rejected.
      },
    });

    // This expense is not written yet - the INSERT comes after evaluation - so
    // it is counted exactly once, here, and never twice.
    return evaluateRules({
      amountMinor: expense.amountMinor,
      category: expense.category,
      countIncludingCurrent: existing + 1,
      policy,
    });
  }
}
