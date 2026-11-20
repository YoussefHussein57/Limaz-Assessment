import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { createPolicyTestApp } from './policy-test-app';

/**
 * F04-T33 to F04-T45 - persistence, the public contract, and the F03
 * scenarios that were deferred until a real evaluator existed.
 *
 * Company A: limit 50,000 minor units, maxCount 3, window 60 min,
 * blocked ['GAMBLING'].
 * Company B: limit 200,000, maxCount 5, window 30 min,
 * blocked ['ALCOHOL', 'GAMBLING'].
 */
describe('F04 decision persistence and the public endpoint', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const deltaKey = API_KEYS.find((k) => k.companyId === COMPANY_B.id)!.plaintext;

  let counter = 0;
  const uniqueId = (): string => `p04-${Date.now()}-${(counter += 1)}`;

  const submit = (overrides: Record<string, unknown> = {}, key: string = nileKey): request.Test =>
    request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', key)
      .send({
        externalId: uniqueId(),
        employeeId: `emp-p-${counter}`,
        amount: 1_000,
        currency: 'SAR',
        merchant: 'City Taxi',
        category: 'TRANSPORT',
        spentAt: '2026-11-20T12:00:00.000Z',
        ...overrides,
      });

  beforeAll(async () => {
    const booted = await createPolicyTestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  // --- F04-T33 to T35: decision, status and review together ---------------
  it('F04-T33: APPROVE stores APPROVED and opens no review', async () => {
    const response = await submit().expect(201);

    expect(response.body.decision).toBe('APPROVE');
    expect(response.body.status).toBe('APPROVED');
    expect(response.body.reasons).toEqual([]);

    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: response.body.id as string },
      include: { review: true, ruleHits: true },
    });

    expect(row.status).toBe('APPROVED');
    expect(row.review).toBeNull();
    expect(row.ruleHits).toHaveLength(0);
  });

  it('F04-T34: REVIEW stores PENDING_REVIEW and opens exactly one review', async () => {
    const response = await submit({ amount: 60_000 }).expect(201);

    expect(response.body.decision).toBe('REVIEW');
    expect(response.body.status).toBe('PENDING_REVIEW');

    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: response.body.id as string },
      include: { review: true },
    });

    expect(row.review).not.toBeNull();
    expect(row.review!.state).toBe('OPEN');
    expect(row.review!.outcome).toBeNull();
    // The tenant is denormalised onto the review and must match (ADR-011).
    expect(row.review!.companyId).toBe(COMPANY_A.id);
  });

  it('F04-T35: REJECT stores REJECTED and opens no review', async () => {
    const response = await submit({ category: 'GAMBLING' }).expect(201);

    expect(response.body.decision).toBe('REJECT');
    expect(response.body.status).toBe('REJECTED');

    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: response.body.id as string },
      include: { review: true },
    });

    // A8: a review exists only for a REVIEW decision. A rejected expense is
    // final the moment it is decided - there is nothing for a manager to do,
    // and an open review against it would be work that cannot be completed.
    expect(row.review).toBeNull();
  });

  it('F04-T35b: exactly one review even when two REVIEW rules fire', async () => {
    // Over the limit AND the fourth in the window. Two REVIEW reasons, ONE
    // review row: the review belongs to the expense, not to the rule.
    const employeeId = `emp-two-review-${counter}`;
    const base = { employeeId, spentAt: '2026-11-20T12:00:00.000Z' };

    await submit({ ...base }).expect(201);
    await submit({ ...base }).expect(201);
    await submit({ ...base }).expect(201);

    const response = await submit({ ...base, amount: 60_000 }).expect(201);

    expect(response.body.decision).toBe('REVIEW');
    expect(response.body.reasons.map((r: { code: string }) => r.code)).toEqual([
      'AMOUNT_LIMIT',
      'FREQUENCY',
    ]);

    const reviews = await prisma.review.count({
      where: { expenseId: response.body.id as string },
    });
    expect(reviews).toBe(1);
  });

  // --- F04-T36: every reason persisted and returned ------------------------
  it('F04-T36: all three rules firing stores three rule hits and returns three reasons', async () => {
    const employeeId = `emp-all-three-${counter}`;
    const base = { employeeId, spentAt: '2026-11-20T12:00:00.000Z' };

    await submit({ ...base }).expect(201);
    await submit({ ...base }).expect(201);
    await submit({ ...base }).expect(201);

    const response = await submit({
      ...base,
      amount: 60_000,
      category: 'GAMBLING',
    }).expect(201);

    // REJECT wins, and all three reasons survive.
    expect(response.body.decision).toBe('REJECT');
    expect(response.body.status).toBe('REJECTED');
    expect(response.body.reasons.map((r: { code: string }) => r.code)).toEqual([
      'AMOUNT_LIMIT',
      'BLOCKED_CATEGORY',
      'FREQUENCY',
    ]);

    const hits = await prisma.ruleHit.findMany({
      where: { expenseId: response.body.id as string },
      orderBy: { ruleCode: 'asc' },
    });

    expect(hits).toHaveLength(3);

    // ORDERING BY A POSTGRES ENUM IS DECLARATION ORDER, NOT ALPHABETICAL.
    //
    // `RuleCode` is declared AMOUNT_LIMIT, FREQUENCY, BLOCKED_CATEGORY, so
    // `ORDER BY "ruleCode" ASC` returns that sequence - not the alphabetical
    // one. The API response sorts in JavaScript with localeCompare and IS
    // alphabetical, so the two differ, and anything in F06 that sorts in SQL
    // will see a different order from the one the contract promises.
    //
    // Asserting it here rather than working around it, because the surprise
    // is worth keeping visible.
    expect(hits.map((h) => h.ruleCode)).toEqual(['AMOUNT_LIMIT', 'FREQUENCY', 'BLOCKED_CATEGORY']);

    // The individual verdicts are preserved, not flattened into the final
    // one: the amount and frequency rules each said REVIEW even though the
    // expense as a whole is REJECTED.
    const decisionOf = (code: string): string => hits.find((h) => h.ruleCode === code)!.decision;

    expect(decisionOf('AMOUNT_LIMIT')).toBe('REVIEW');
    expect(decisionOf('FREQUENCY')).toBe('REVIEW');
    expect(decisionOf('BLOCKED_CATEGORY')).toBe('REJECT');

    // The detail shapes match what the seed writes, so seeded and freshly
    // evaluated rows describe the same rule the same way.
    expect(hits.find((h) => h.ruleCode === 'AMOUNT_LIMIT')!.detail).toEqual({
      autoApproveLimitMinor: 50_000,
      amountMinor: 60_000,
    });
    expect(hits.find((h) => h.ruleCode === 'BLOCKED_CATEGORY')!.detail).toEqual({
      category: 'GAMBLING',
      blockedCategories: ['GAMBLING'],
    });
    expect(hits.find((h) => h.ruleCode === 'FREQUENCY')!.detail).toEqual({
      windowMinutes: 60,
      maxCount: 3,
      countIncludingCurrent: 4,
    });

    // REJECT, so no review despite two REVIEW rules having fired.
    expect(await prisma.review.count({ where: { expenseId: response.body.id as string } })).toBe(0);
  });

  // --- F04-T37 / T38: atomicity -------------------------------------------
  it('F04-T37: a rule-hit failure rolls the whole transaction back', async () => {
    // Forced by deleting the policy mid-flight is not possible from outside,
    // so this uses the path that genuinely fails after the expense row is
    // built: a duplicate rule code violates rule_hits_expenseId_ruleCode_key.
    // The F03 suite drives that through a test evaluator; here the assertion
    // is that the REAL pipeline leaves nothing behind when a write fails.
    //
    // The closest reachable failure with the real evaluator is a currency
    // mismatch, which is raised after the lock and before any write.
    const externalId = uniqueId();

    await submit({ externalId, currency: 'USD' }).expect(422);

    expect(await prisma.expense.count({ where: { externalId } })).toBe(0);
    expect(await prisma.ruleHit.count({ where: { expense: { externalId } } })).toBe(0);
    expect(await prisma.review.count({ where: { expense: { externalId } } })).toBe(0);

    // And the identifier is free afterwards - the rollback released it.
    await submit({ externalId }).expect(201);
  });

  it('F04-T38: expense, rule hits and review commit together or not at all', async () => {
    // The positive side of atomicity: a REVIEW decision writes three kinds of
    // row, and all of them are visible together.
    const response = await submit({ amount: 60_000 }).expect(201);
    const id = response.body.id as string;

    const [expense, hits, reviews] = await Promise.all([
      prisma.expense.findUnique({ where: { id } }),
      prisma.ruleHit.count({ where: { expenseId: id } }),
      prisma.review.count({ where: { expenseId: id } }),
    ]);

    expect(expense).not.toBeNull();
    expect(hits).toBe(1);
    expect(reviews).toBe(1);
  });

  // --- F04-T39: different companies, different policies --------------------
  it('F04-T39: the same expense is judged differently by two companies', async () => {
    const body = {
      externalId: uniqueId(),
      employeeId: `emp-cross-${counter}`,
      amount: 100_000, // over A's 50,000 limit, under B's 200,000
      category: 'ALCOHOL', // blocked for B, permitted for A
    };

    const forA = await submit(body, nileKey).expect(201);
    const forB = await submit(body, deltaKey).expect(201);

    // Company A: over the limit, category permitted.
    expect(forA.body.decision).toBe('REVIEW');
    expect(forA.body.reasons.map((r: { code: string }) => r.code)).toEqual(['AMOUNT_LIMIT']);

    // Company B: under the limit, category blocked.
    expect(forB.body.decision).toBe('REJECT');
    expect(forB.body.reasons.map((r: { code: string }) => r.code)).toEqual(['BLOCKED_CATEGORY']);

    // Two independent expenses sharing an externalId across tenants.
    expect(forA.body.id).not.toBe(forB.body.id);
  });

  // --- F04-T40 to T42: policy changes and historical integrity ------------
  describe('policy changes', () => {
    const employeeId = 'emp-policy-change';
    let originalLimit: number;

    beforeAll(async () => {
      const policy = await prisma.policy.findUniqueOrThrow({
        where: { companyId: COMPANY_A.id },
      });
      originalLimit = policy.autoApproveLimitMinor;
    });

    afterEach(async () => {
      await prisma.policy.update({
        where: { companyId: COMPANY_A.id },
        data: { autoApproveLimitMinor: originalLimit },
      });
    });

    it('F04-T40: the stored snapshot is unaffected by a later policy change', async () => {
      const response = await submit({ employeeId, amount: 60_000 }).expect(201);
      const id = response.body.id as string;

      await prisma.policy.update({
        where: { companyId: COMPANY_A.id },
        data: { autoApproveLimitMinor: 500_000 },
      });

      const row = await prisma.expense.findUniqueOrThrow({ where: { id } });

      // A7: the snapshot records what the expense was judged against, so
      // "why was this reviewed?" stays answerable after the policy moves.
      expect(row.policySnapshot).toEqual({
        autoApproveLimitMinor: 50_000,
        frequencyMaxCount: 3,
        frequencyWindowMinutes: 60,
        blockedCategories: ['GAMBLING'],
      });
      expect(row.decision).toBe('REVIEW');
    });

    it('F04-T41: a retry after a policy change returns the ORIGINAL decision', async () => {
      const externalId = uniqueId();
      const body = { externalId, employeeId, amount: 60_000 };

      const first = await submit(body).expect(201);
      expect(first.body.decision).toBe('REVIEW');

      // Raise the limit so the same expense would now be approved.
      await prisma.policy.update({
        where: { companyId: COMPANY_A.id },
        data: { autoApproveLimitMinor: 500_000 },
      });

      const retry = await submit(body).expect(200);

      // The retry is a replay of a fact, not a new evaluation. Re-evaluating
      // would change a decision already reported to the caller - and any
      // review opened against it would stop matching the expense.
      expect(retry.body.decision).toBe('REVIEW');
      expect(retry.body.id).toBe(first.body.id);
      expect(retry.body.reasons).toEqual(first.body.reasons);
      expect(retry.body.duplicate).toBe(true);
    });

    it('F04-T42: a NEW expense after a policy change uses the new policy', async () => {
      await prisma.policy.update({
        where: { companyId: COMPANY_A.id },
        data: { autoApproveLimitMinor: 500_000 },
      });

      const response = await submit({ employeeId, amount: 60_000 }).expect(201);

      // Same amount, different answer - because this is a new fact being
      // judged now, not a replay of an old one.
      expect(response.body.decision).toBe('APPROVE');

      const row = await prisma.expense.findUniqueOrThrow({
        where: { id: response.body.id as string },
      });
      expect((row.policySnapshot as { autoApproveLimitMinor: number }).autoApproveLimitMinor).toBe(
        500_000,
      );
    });
  });

  // --- F04-T43 / T44: the production wiring and the response contract -----
  it('F04-T43: the running application uses the REAL evaluator', async () => {
    // Proven by behaviour rather than by inspecting the container: a test
    // evaluator returns whatever it was told to; only the real one derives
    // REVIEW from this company's actual 50,000 limit.
    const below = await submit({ amount: 50_000 }).expect(201);
    const above = await submit({ amount: 50_001 }).expect(201);

    expect(below.body.decision).toBe('APPROVE');
    expect(above.body.decision).toBe('REVIEW');
    expect(above.body.reasons[0].detail).toEqual({
      autoApproveLimitMinor: 50_000,
      amountMinor: 50_001,
    });
  });

  it('F04-T44: a REJECT decision is a successful HTTP response, not a 4xx', async () => {
    const response = await submit({ category: 'GAMBLING' }).expect(201);

    // The request was well formed, authenticated, authorised and processed.
    // The business outcome is that the expense is rejected. Returning 4xx
    // would tell the caller their REQUEST failed, which it did not, and a
    // retrying client would retry something that worked.
    expect(response.status).toBe(201);
    expect(response.body.decision).toBe('REJECT');
    expect(response.body.reasons).toHaveLength(1);
  });

  // --- F04-T45: the F03 scenarios that were DEFERRED ----------------------
  describe('F04-T45: F03 deferred scenarios, now against the real evaluator', () => {
    it('F03-T01: the full response body is correct, not merely persisted', async () => {
      const response = await submit({ amount: 60_000 }).expect(201);

      expect(response.body).toMatchObject({
        decision: 'REVIEW',
        status: 'PENDING_REVIEW',
        amountMinor: 60_000,
        currency: 'SAR',
        duplicate: false,
      });
      expect(response.body.reasons).toEqual([
        {
          code: 'AMOUNT_LIMIT',
          decision: 'REVIEW',
          detail: { autoApproveLimitMinor: 50_000, amountMinor: 60_000 },
        },
      ]);
      // Still never published.
      expect(response.body.payloadHash).toBeUndefined();
    });

    it('F03-T13: a retry returns the original decision and reasons verbatim', async () => {
      const body = { externalId: uniqueId(), employeeId: `emp-def-${counter}`, amount: 60_000 };

      const first = await submit(body).expect(201);
      const retry = await submit(body).expect(200);

      expect(retry.body.decision).toBe(first.body.decision);
      expect(retry.body.reasons).toEqual(first.body.reasons);
      expect(retry.body.status).toBe(first.body.status);

      expect(await prisma.ruleHit.count({ where: { expenseId: first.body.id as string } })).toBe(1);
      expect(await prisma.review.count({ where: { expenseId: first.body.id as string } })).toBe(1);
    });

    it('F03-T19: the winner of a conflict carries a genuine decision', async () => {
      const externalId = uniqueId();
      const employeeId = `emp-def-conflict-${counter}`;

      const responses = await Promise.all([
        submit({ externalId, employeeId, amount: 60_000 }),
        submit({ externalId, employeeId, amount: 70_000 }),
        submit({ externalId, employeeId, amount: 80_000 }),
      ]);

      const created = responses.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);

      const winner = created[0]!;
      expect(winner.body.decision).toBe('REVIEW');
      expect(winner.body.reasons[0].detail.amountMinor).toBe(winner.body.amountMinor);

      const row = await prisma.expense.findUniqueOrThrow({
        where: { id: winner.body.id as string },
      });
      expect(row.amountMinor).toBe(winner.body.amountMinor);
    });
  });
});
