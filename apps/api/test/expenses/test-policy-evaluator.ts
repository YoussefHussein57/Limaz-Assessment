import type {
  PolicyEvaluationInput,
  PolicyEvaluationResult,
  PolicyEvaluator,
} from '../../src/expenses/policy-evaluator.port';

/**
 * A policy evaluator that exists ONLY in tests.
 *
 * F03 verifies orchestration: validation, canonicalisation, idempotency, the
 * transaction, conflict classification and persistence. It does not verify
 * decisions, because the rules are F04. This evaluator therefore returns a
 * decision the test chose, so that an assertion about a stored decision is an
 * assertion about PERSISTENCE, never about policy.
 *
 * It is not a mock standing in for a database. The database in every test here
 * is the real PostgreSQL instance; only the seam declared by the port is
 * substituted, which is the seam F04 will fill.
 */
/**
 * What a test is allowed to see about a call.
 *
 * Deliberately NOT the whole `PolicyEvaluationInput`: that carries the
 * transaction client, and Jest serialises the received value when an
 * assertion fails. Keeping it caused a failing `toHaveLength` to blow up with
 * `RangeError: Invalid string length` while printing a Prisma client, which
 * replaced the real failure message with a stack trace about string length.
 */
export interface RecordedCall {
  readonly companyId: string;
  readonly employeeId: string;
  readonly amountMinor: number;
  readonly category: string;
  readonly policyId: string;
}

export class TestPolicyEvaluator implements PolicyEvaluator {
  /** Every call, in order, so a test can assert it ran exactly once. */
  readonly calls: RecordedCall[] = [];

  private result: PolicyEvaluationResult = {
    decision: 'APPROVE',
    ruleHits: [],
  };

  private barrier: Barrier | null = null;
  private failure: Error | null = null;

  returning(result: PolicyEvaluationResult): this {
    this.result = result;

    return this;
  }

  /**
   * Makes the evaluator throw, to exercise a mid-transaction failure.
   *
   * It runs after the advisory lock and before the INSERT, which is the window
   * that must leave nothing behind (test F03-T22).
   */
  failingWith(error: Error | null): this {
    this.failure = error;

    return this;
  }

  /** Clears a barrier set by a previous test, so suites cannot leak into each other. */
  withoutBarrier(): this {
    this.barrier = null;

    return this;
  }

  /**
   * Holds every caller here until `size` of them have arrived.
   *
   * This is what makes a concurrency test a real race rather than a hope about
   * timing. The evaluator runs INSIDE the transaction, after the advisory
   * lock, so when the contending requests use different lock keys they can all
   * be sitting here at once, each holding an open transaction. Releasing them
   * together makes their INSERTs genuinely overlap.
   *
   * It cannot be used for requests that share a lock key: those serialise on
   * the lock by design, so the second would never reach the barrier and the
   * test would simply wait. The timeout below turns that mistake into a named
   * failure in seconds instead of a suite that hangs until Jest gives up.
   */
  withBarrier(size: number, timeoutMs = 5_000): this {
    this.barrier = new Barrier(size, timeoutMs);

    return this;
  }

  async evaluate(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult> {
    this.calls.push({
      companyId: input.companyId,
      employeeId: input.expense.employeeId,
      amountMinor: input.expense.amountMinor,
      category: input.expense.category,
      policyId: input.policy.id,
    });

    if (this.barrier) {
      await this.barrier.arrive();
    }

    if (this.failure) {
      throw this.failure;
    }

    return this.result;
  }
}

/**
 * A rendezvous for N participants, with a bounded wait.
 *
 * The timeout is not defensive decoration. Without it, a barrier sized wrongly
 * - or one placed where the advisory lock serialises its participants - makes
 * every waiter block forever, holding an open transaction and a pooled
 * connection. The suite would stall, and the cause would be invisible. With
 * it, the test fails in five seconds saying exactly how many of how many
 * arrived.
 */
export class Barrier {
  private arrived = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly size: number,
    private readonly timeoutMs: number,
  ) {}

  async arrive(): Promise<void> {
    this.arrived += 1;

    if (this.arrived >= this.size) {
      // The last participant releases everyone, itself included.
      for (const release of this.waiting.splice(0)) {
        release();
      }

      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter so a later release does not resolve a settled
        // promise, which would hide the failure.
        const index = this.waiting.indexOf(release);

        if (index !== -1) {
          this.waiting.splice(index, 1);
        }

        reject(
          new Error(
            `Barrier timed out after ${this.timeoutMs}ms: ${this.arrived} of ${this.size} ` +
              `participants arrived. Either fewer requests reached the evaluator than ` +
              `expected, or they serialised on the advisory lock before getting here.`,
          ),
        );
      }, this.timeoutMs);

      const release = (): void => {
        clearTimeout(timer);
        resolve();
      };

      this.waiting.push(release);
    });
  }
}
