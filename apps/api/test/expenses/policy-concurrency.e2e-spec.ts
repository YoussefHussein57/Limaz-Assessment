import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { createPolicyTestApp, type RequestBarrierInterceptor } from './policy-test-app';

/**
 * F04-T26 to F04-T32 - the frequency rule under genuine concurrency.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BARRIER IS WHERE IT IS
 * ---------------------------------------------------------------------------
 *
 * F03's barrier lives inside the evaluator, which runs AFTER the advisory
 * lock is granted. For requests with different lock keys that is fine. For
 * requests that SHARE a lock key - which is the whole point of these tests -
 * it would deadlock: only the holder can proceed, so the others never arrive
 * and every participant waits until the timeout.
 *
 * So the barrier here is an interceptor that runs BEFORE the controller,
 * before the transaction opens and before the lock is attempted. All five
 * requests are released together and then race for the lock exactly as five
 * real clients would.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THE ASSERTION MEANINGFUL
 * ---------------------------------------------------------------------------
 *
 * 3 APPROVE + 2 REVIEW is only reachable if the five transactions SERIALISED:
 * each has to see the ones before it. Without the lock they would all count
 * zero and all approve. So the outcome itself is the evidence, and the
 * negative control in `frequency-negative-control.e2e-spec.ts` demonstrates
 * the failure directly.
 *
 * `DB_POOL_MAX` is 10, above every concurrency used here. With a smaller
 * pool the requests would queue inside the pool and run one at a time, and
 * these tests would pass without the database being contended at all - risk
 * R-10.
 */
describe('F04 concurrent frequency evaluation', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let barrier: RequestBarrierInterceptor;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const deltaKey = API_KEYS.find((k) => k.companyId === COMPANY_B.id)!.plaintext;

  /** One fixed instant for every request, so they are provably in one window. */
  const SPENT_AT = '2026-11-20T12:00:00.000Z';

  const submit = (body: Record<string, unknown>, key: string = nileKey): request.Test =>
    request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', key)
      .send({
        employeeId: 'emp-race',
        amount: 1_000,
        currency: 'SAR',
        merchant: 'City Taxi',
        category: 'TRANSPORT',
        spentAt: SPENT_AT,
        ...body,
      });

  beforeAll(async () => {
    const booted = await createPolicyTestApp();
    app = booted.app;
    prisma = booted.prisma;
    barrier = booted.barrier;

    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  beforeEach(async () => {
    barrier.disarm();
    await prisma.ruleHit.deleteMany({
      where: { expense: { employeeId: { startsWith: 'emp-race' } } },
    });
    await prisma.review.deleteMany({
      where: { expense: { employeeId: { startsWith: 'emp-race' } } },
    });
    await prisma.expense.deleteMany({ where: { employeeId: { startsWith: 'emp-race' } } });
  });

  // --- F04-T26: the one that matters ---------------------------------------
  it('F04-T26: five simultaneous distinct expenses give exactly three APPROVE and two REVIEW', async () => {
    // Preconditions, stated because every one of them is load-bearing:
    //  - the employee has no history (cleared in beforeEach)
    //  - five DIFFERENT externalIds, so none is a retry
    //  - the same company, the same employee, the same spentAt
    //  - maxCount is 3 (company A's seeded policy)
    //  - amounts under the 50,000 limit and a permitted category, so the
    //    frequency rule is the only one that can fire
    barrier.arm(5, 15_000);

    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => submit({ externalId: `race-${i}` })),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);

    const decisions = responses.map((r) => r.body.decision as string).sort();
    expect(decisions).toEqual(['APPROVE', 'APPROVE', 'APPROVE', 'REVIEW', 'REVIEW']);

    // Persisted state, not just responses.
    const stored = await prisma.expense.findMany({ where: { employeeId: 'emp-race' } });
    expect(stored).toHaveLength(5);
    expect(stored.filter((e) => e.decision === 'APPROVE')).toHaveLength(3);
    expect(stored.filter((e) => e.decision === 'REVIEW')).toHaveLength(2);
    expect(stored.every((e) => e.companyId === COMPANY_A.id)).toBe(true);

    // Status follows decision, as the CHECK constraint requires.
    expect(stored.filter((e) => e.status === 'APPROVED')).toHaveLength(3);
    expect(stored.filter((e) => e.status === 'PENDING_REVIEW')).toHaveLength(2);

    const reviews = await prisma.review.findMany({
      where: { expense: { employeeId: 'emp-race' } },
    });
    expect(reviews).toHaveLength(2);
    expect(reviews.every((r) => r.state === 'OPEN')).toBe(true);

    const hits = await prisma.ruleHit.findMany({
      where: { expense: { employeeId: 'emp-race' } },
    });
    expect(hits.filter((h) => h.ruleCode === 'FREQUENCY')).toHaveLength(2);

    // The counts recorded are 4 and 5 - which is only possible if the
    // transactions saw each other, in order.
    const counts = hits
      .filter((h) => h.ruleCode === 'FREQUENCY')
      .map((h) => (h.detail as { countIncludingCurrent: number }).countIncludingCurrent)
      .sort();
    expect(counts).toEqual([4, 5]);

    // WHICH request was reviewed is NOT asserted. Lock acquisition order is
    // not determined, so asserting an identity would be flaky by design.
  }, 30_000);

  // --- F04-T27 / T28: F03 guarantees still hold with the real evaluator ----
  it('F04-T27: simultaneous identical retries persist one expense', async () => {
    barrier.arm(5, 15_000);

    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map(() => submit({ externalId: 'race-same' })),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(4);

    const stored = await prisma.expense.findMany({ where: { externalId: 'race-same' } });
    expect(stored).toHaveLength(1);

    // Four retries contributed nothing to the window, so the single expense
    // is the first in it.
    expect(stored[0]!.decision).toBe('APPROVE');
  }, 30_000);

  it('F04-T28: concurrent conflicting payloads leave exactly one winner', async () => {
    barrier.arm(3, 15_000);

    const responses = await Promise.all([
      submit({ externalId: 'race-conflict', amount: 1_000 }),
      submit({ externalId: 'race-conflict', amount: 2_000 }),
      submit({ externalId: 'race-conflict', amount: 3_000 }),
    ]);

    const created = responses.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(2);

    const stored = await prisma.expense.findMany({ where: { externalId: 'race-conflict' } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.amountMinor).toBe(created[0]!.body.amountMinor);
  }, 30_000);

  // --- F04-T29 / T30: independence -----------------------------------------
  it('F04-T29: two companies have independent frequency counts', async () => {
    // Same employeeId, same instant, different companies. The lock key
    // includes the company, so nothing contends, and the counts are separate.
    barrier.arm(8, 15_000);

    const responses = await Promise.all([
      ...[1, 2, 3, 4].map((i) => submit({ externalId: `race-a-${i}` }, nileKey)),
      ...[1, 2, 3, 4].map((i) => submit({ externalId: `race-b-${i}` }, deltaKey)),
    ]);

    expect(responses.every((r) => r.status === 201)).toBe(true);

    const a = await prisma.expense.findMany({
      where: { companyId: COMPANY_A.id, employeeId: 'emp-race' },
    });
    const b = await prisma.expense.findMany({
      where: { companyId: COMPANY_B.id, employeeId: 'emp-race' },
    });

    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);

    // Company A: maxCount 3, so the fourth is REVIEW.
    expect(a.filter((e) => e.decision === 'REVIEW')).toHaveLength(1);
    // Company B: maxCount 5, so four expenses are all fine.
    expect(b.filter((e) => e.decision === 'REVIEW')).toHaveLength(0);
  }, 30_000);

  it('F04-T30: two employees have independent frequency counts', async () => {
    barrier.arm(8, 15_000);

    const responses = await Promise.all([
      ...[1, 2, 3, 4].map((i) =>
        submit({ externalId: `race-e1-${i}`, employeeId: 'emp-race-one' }),
      ),
      ...[1, 2, 3].map((i) => submit({ externalId: `race-e2-${i}`, employeeId: 'emp-race-two' })),
      submit({ externalId: 'race-e2-4', employeeId: 'emp-race-two' }),
    ]);

    expect(responses.every((r) => r.status === 201)).toBe(true);

    for (const employeeId of ['emp-race-one', 'emp-race-two']) {
      const rows = await prisma.expense.findMany({ where: { employeeId } });
      expect(rows).toHaveLength(4);
      // Each employee independently reaches four, so each gets exactly one
      // REVIEW. If the lock were keyed on the company alone they would share
      // a window and the result would be one APPROVE short.
      expect(rows.filter((e) => e.decision === 'REVIEW')).toHaveLength(1);
    }
  }, 30_000);

  // --- F04-T31: new expenses mixed with retries ----------------------------
  it('F04-T31: only distinct expenses contribute when retries are mixed in', async () => {
    barrier.arm(6, 15_000);

    const responses = await Promise.all([
      submit({ externalId: 'race-mix-1' }),
      submit({ externalId: 'race-mix-1' }),
      submit({ externalId: 'race-mix-2' }),
      submit({ externalId: 'race-mix-2' }),
      submit({ externalId: 'race-mix-3' }),
      submit({ externalId: 'race-mix-3' }),
    ]);

    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(3);

    const stored = await prisma.expense.findMany({ where: { employeeId: 'emp-race' } });
    expect(stored).toHaveLength(3);

    // Three distinct expenses is not more than three, so none is reviewed.
    // Had the retries counted, the third would have seen a count of five.
    expect(stored.every((e) => e.decision === 'APPROVE')).toBe(true);
  }, 30_000);

  // --- F04-T32: failure while holding the lock -----------------------------
  it('F04-T32: a failure while holding the lock rolls back and releases it', async () => {
    // An amount above the int4 range would be a 400; a currency mismatch is a
    // 422 raised INSIDE the transaction, after the lock is held. That is the
    // window being tested.
    const failed = await submit({ externalId: 'race-fail', currency: 'USD' }).expect(422);
    expect(failed.body.error).toBe('currency_mismatch');

    expect(await prisma.expense.count({ where: { externalId: 'race-fail' } })).toBe(0);

    // If the lock had leaked onto the pooled connection, this submission for
    // the SAME employee would block until the test timed out.
    const after = await submit({ externalId: 'race-fail-2' }).expect(201);
    expect(after.body.decision).toBe('APPROVE');
  }, 20_000);
});
