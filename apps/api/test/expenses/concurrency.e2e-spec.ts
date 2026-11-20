import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { createExpensesTestApp } from './expenses-test-app';
import { TestPolicyEvaluator } from './test-policy-evaluator';

/**
 * F03-T17 to F03-T22 - concurrency against real PostgreSQL.
 *
 * ---------------------------------------------------------------------------
 * THE THING THAT MAKES THESE TESTS WORTH ANYTHING
 * ---------------------------------------------------------------------------
 *
 * `Promise.all` proves nothing on its own. Five requests launched together can
 * still execute one after another - inside the connection pool, inside the
 * event loop, or because a lock serialised them - and the test passes without
 * the race it claims to exercise ever happening.
 *
 * So two things are arranged deliberately:
 *
 * 1. `DB_POOL_MAX` is 10, above every concurrency used here. With a pool of
 *    one, the requests queue in the pool and the suite is vacuous (risk R-10).
 *
 * 2. A BARRIER inside the test evaluator, which runs within the transaction
 *    after the advisory lock. Every participant stops there holding an open
 *    transaction, and they are released together - so their INSERTs genuinely
 *    overlap. Every barrier is bounded by a timeout, so a wrongly sized one
 *    fails in seconds with a message naming how many arrived, instead of
 *    hanging the suite with every waiter holding a pooled connection.
 *
 * ---------------------------------------------------------------------------
 * WHICH MECHANISM ACTUALLY FIRES, AND WHEN
 * ---------------------------------------------------------------------------
 *
 * The advisory lock is keyed on (companyId, employeeId). That has a
 * consequence worth naming, because it is not obvious and it shapes every
 * test below:
 *
 *   SAME employeeId   -> the lock serialises them. The second request finds
 *                        the first one's committed row at the idempotency
 *                        step and returns 200. THE UNIQUE CONSTRAINT NEVER
 *                        FIRES.
 *
 *   DIFFERENT employeeId -> different lock keys, so the transactions run in
 *                        parallel and both reach the INSERT. The unique
 *                        constraint is what decides, and the loser takes the
 *                        aborted-transaction path.
 *
 * A suite testing only the first shape would pass with the constraint dropped
 * entirely. That is why F03-T21 exists, and why the negative control uses it.
 */
describe('F03 concurrent submission', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let evaluator: TestPolicyEvaluator;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const deltaKey = API_KEYS.find((k) => k.companyId === COMPANY_B.id)!.plaintext;

  const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    externalId: 'exp-race',
    employeeId: 'emp-race',
    amount: 12_500,
    currency: 'SAR',
    merchant: 'City Taxi',
    category: 'TRANSPORT',
    spentAt: '2026-11-20T09:15:00.000Z',
    ...overrides,
  });

  const post = (body: Record<string, unknown>, key: string = nileKey) =>
    request(app.getHttpServer()).post('/v1/expenses').set('x-api-key', key).send(body);

  beforeAll(async () => {
    evaluator = new TestPolicyEvaluator();

    const booted = await createExpensesTestApp(evaluator);
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  beforeEach(() => {
    evaluator.calls.length = 0;
    evaluator.withoutBarrier().failingWith(null);
  });

  // --- F03-T17 -------------------------------------------------------------
  it('F03-T17: two concurrent identical requests persist exactly one expense', async () => {
    const body = valid({ externalId: 'exp-t17' });

    const [a, b] = await Promise.all([post(body), post(body)]);

    const statuses = [a.status, b.status].sort();
    // One created it, one replayed it. Which is which is not determined, so
    // the assertion is on the MULTISET of outcomes, never on identities.
    expect(statuses).toEqual([200, 201]);

    const rows = await prisma.expense.findMany({ where: { externalId: 'exp-t17' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(COMPANY_A.id);

    // Both responses describe the SAME expense.
    expect(a.body.id).toBe(b.body.id);
  });

  // --- F03-T18 -------------------------------------------------------------
  it('F03-T18: five concurrent identical requests persist exactly one expense', async () => {
    const body = valid({ externalId: 'exp-t18' });

    const responses = await Promise.all([1, 2, 3, 4, 5].map(() => post(body)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(4);
    expect(responses.every((r) => r.status < 400)).toBe(true);

    const rows = await prisma.expense.findMany({ where: { externalId: 'exp-t18' } });
    expect(rows).toHaveLength(1);

    // One evaluation for five requests. Five would mean four retries were
    // counted toward a future frequency window.
    expect(evaluator.calls).toHaveLength(1);

    // No duplicate side effects.
    expect(await prisma.ruleHit.count({ where: { expenseId: rows[0]!.id } })).toBe(0);
    expect(await prisma.review.count({ where: { expenseId: rows[0]!.id } })).toBe(0);

    const ids = new Set(responses.map((r) => r.body.id as string));
    expect(ids.size).toBe(1);
  });

  // --- F03-T19 -------------------------------------------------------------
  it('F03-T19: concurrent conflicting payloads produce one winner and refusals', async () => {
    const externalId = 'exp-t19';

    const responses = await Promise.all([
      post(valid({ externalId, amount: 10_000 })),
      post(valid({ externalId, amount: 20_000 })),
      post(valid({ externalId, amount: 30_000 })),
    ]);

    const created = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(2);

    const rows = await prisma.expense.findMany({ where: { externalId } });
    expect(rows).toHaveLength(1);

    // The stored amount is the WINNER's, and the winner is whichever request
    // got there first - not a fixed one. Asserting a particular amount would
    // be flaky; asserting that the row matches the 201 is the real invariant.
    expect(rows[0]!.amountMinor).toBe(created[0]!.body.amountMinor);
    expect(rows[0]!.id).toBe(created[0]!.body.id);

    // And every refusal points at the row that actually exists.
    for (const response of refused) {
      expect(response.body.details.existing.id).toBe(rows[0]!.id);
    }
  });

  // --- F03-T21: the shape where the UNIQUE CONSTRAINT is the decider -------
  it('F03-T21: concurrent same externalId with different employeeIds - the constraint decides', async () => {
    const externalId = 'exp-t21';

    // Different employeeId means a DIFFERENT advisory lock key, so these two
    // transactions genuinely run side by side. The barrier holds both inside
    // their transactions until both have arrived, then releases them together,
    // so the INSERTs overlap by construction rather than by luck.
    evaluator.withBarrier(2, 5_000);

    const responses = await Promise.all([
      post(valid({ externalId, employeeId: 'emp-alpha' })),
      post(valid({ externalId, employeeId: 'emp-beta' })),
    ]);

    // Proof the barrier was actually reached by both: if the lock had
    // serialised them, the second would never have arrived and the barrier
    // would have timed out with a named error instead.
    expect(evaluator.calls).toHaveLength(2);

    const statuses = responses.map((r) => r.status).sort();
    // One wins. The loser carries a different employeeId, so its payload hash
    // differs from the winner's and it is a conflict, not a retry.
    expect(statuses).toEqual([201, 409]);

    const rows = await prisma.expense.findMany({ where: { externalId } });
    expect(rows).toHaveLength(1);

    // No 500. The loser's transaction aborted on 23505 and the outcome was
    // resolved on a fresh connection afterwards - the path that fails if
    // anyone tries to query inside the aborted transaction.
    expect(responses.some((r) => r.status >= 500)).toBe(false);

    const winner = responses.find((r) => r.status === 201)!;
    expect(rows[0]!.employeeId).toBe(winner.body.employeeId);
  });

  /*
   * There is NO test here for "lost the insert race with an IDENTICAL
   * payload", and the reason is structural rather than an omission.
   *
   * Reaching the INSERT race requires two different advisory lock keys, which
   * means a different companyId or a different employeeId. A different company
   * does not share the constraint, and a different employeeId changes the
   * payload hash - so a losing request on that path is always a conflict, not
   * a retry. The identical-payload case is served by the lock instead, and is
   * F03-T17 and F03-T18 above.
   *
   * The `resolveExisting()` branch that both paths funnel through is the same
   * function, which is why it is written once rather than duplicated per path.
   */

  // --- F03-T20 under concurrency -------------------------------------------
  it('F03-T20c: concurrent submissions of one externalId in two companies both succeed', async () => {
    const body = valid({ externalId: 'exp-t20c' });

    // Different companies, so different lock keys AND different constraint
    // rows. Nothing should contend at all.
    evaluator.withBarrier(2, 5_000);

    const [a, b] = await Promise.all([post(body, nileKey), post(body, deltaKey)]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);

    const rows = await prisma.expense.findMany({ where: { externalId: 'exp-t20c' } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.companyId))).toEqual(new Set([COMPANY_A.id, COMPANY_B.id]));
  });

  // --- F03-T22 -------------------------------------------------------------
  it('F03-T22: a failure before commit leaves nothing behind', async () => {
    const externalId = 'exp-t22';

    // The evaluator throws AFTER the advisory lock and BEFORE the insert -
    // the window in which a partial write would be possible if the expense,
    // its rule hits and its review were not one transaction.
    evaluator.failingWith(new Error('policy engine exploded'));

    const response = await post(valid({ externalId }));

    // A controlled 500 with a fixed message, not a stack trace.
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain('exploded');

    expect(await prisma.expense.count({ where: { externalId } })).toBe(0);

    evaluator.failingWith(null);

    // And the identifier is still free afterwards: the rollback released it.
    await post(valid({ externalId })).expect(201);
  });

  it('F03-T22b: the advisory lock is released by the rollback', async () => {
    // If the lock were session-scoped it would survive the failed transaction
    // and poison the pooled connection, and this second submission for the
    // same employee would hang until the test timed out.
    evaluator.failingWith(new Error('first attempt fails'));
    await post(valid({ externalId: 'exp-t22b-1', employeeId: 'emp-lock' })).expect(500);

    evaluator.failingWith(null);
    await post(valid({ externalId: 'exp-t22b-2', employeeId: 'emp-lock' })).expect(201);
  }, 15_000);

  // --- F03-T24 -------------------------------------------------------------
  it('F03-T24: an unrelated database error is not reported as a conflict', async () => {
    // A unique violation on a DIFFERENT constraint. If the classifier merely
    // asked "was this P2002?", the caller would be told their expense already
    // existed - and would stop retrying an expense that was never written.
    const externalId = 'exp-t24';

    evaluator.returning({
      decision: 'APPROVE',
      ruleHits: [
        { ruleCode: 'AMOUNT_LIMIT', decision: 'APPROVE', detail: { ok: true } },
        // The SAME rule twice violates rule_hits_expenseId_ruleCode_key.
        { ruleCode: 'AMOUNT_LIMIT', decision: 'APPROVE', detail: { ok: true } },
      ],
    });

    const response = await post(valid({ externalId }));

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('internal_error');
    // Specifically NOT 200 or 409.
    expect([200, 201, 409]).not.toContain(response.status);

    // And the transaction rolled back, so no half-written expense survives.
    expect(await prisma.expense.count({ where: { externalId } })).toBe(0);

    evaluator.returning({ decision: 'APPROVE', ruleHits: [] });
  });

  it('F03-T24b: the error body never names a constraint or a table', async () => {
    evaluator.returning({
      decision: 'APPROVE',
      ruleHits: [
        { ruleCode: 'FREQUENCY', decision: 'APPROVE', detail: {} },
        { ruleCode: 'FREQUENCY', decision: 'APPROVE', detail: {} },
      ],
    });

    const response = await post(valid({ externalId: 'exp-t24b' }));
    const body = JSON.stringify(response.body);

    expect(body).not.toMatch(/rule_hits|expenses|constraint|23505|P2002/u);

    evaluator.returning({ decision: 'APPROVE', ruleHits: [] });
  });
});
