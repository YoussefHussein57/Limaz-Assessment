import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { createPolicyTestApp } from './policy-test-app';

/**
 * F04-T16 to F04-T25 - what the frequency window includes, against the real
 * database and the real query.
 *
 * The window is backward-looking with both ends inclusive (ADR-002):
 *
 *     [spentAt - frequencyWindowMinutes, spentAt]
 *
 * Company A's policy: window 60 minutes, maxCount 3, auto-approve 50,000
 * minor units, blocked categories ['GAMBLING'].
 *
 * Every expense below is well under the amount limit and in a permitted
 * category, so the ONLY rule that can fire is the frequency one. That
 * isolation is deliberate: a REVIEW here means the window counted something,
 * not that some other rule happened to trigger.
 */
describe('F04 frequency window', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  /** A fixed instant, so the tests do not depend on when they run. */
  const BASE = new Date('2026-11-20T12:00:00.000Z');
  const at = (minutes: number, ms = 0): Date => new Date(BASE.getTime() + minutes * 60_000 + ms);

  let counter = 0;
  const uniqueId = (): string => `f04-${Date.now()}-${(counter += 1)}`;

  const submit = (overrides: Record<string, unknown> = {}, key: string = nileKey): request.Test =>
    request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', key)
      .send({
        externalId: uniqueId(),
        employeeId: 'emp-window',
        amount: 1_000,
        currency: 'SAR',
        merchant: 'City Taxi',
        category: 'TRANSPORT',
        spentAt: at(0).toISOString(),
        ...overrides,
      });

  /**
   * Inserts an expense directly, bypassing the API.
   *
   * Needed because the API refuses a `spentAt` outside the A4 window and
   * because these tests need a precisely controlled history. The rows are
   * real and are what the production COUNT query reads.
   */
  const given = async (
    spentAt: Date,
    overrides: {
      employeeId?: string;
      companyId?: string;
      decision?: 'APPROVE' | 'REJECT' | 'REVIEW';
    } = {},
  ): Promise<void> => {
    const decision = overrides.decision ?? 'APPROVE';
    const status =
      decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'PENDING_REVIEW';

    await prisma.expense.create({
      data: {
        companyId: overrides.companyId ?? COMPANY_A.id,
        externalId: uniqueId(),
        employeeId: overrides.employeeId ?? 'emp-window',
        amountMinor: 1_000,
        currency: 'SAR',
        merchant: 'City Taxi',
        category: 'TRANSPORT',
        spentAt,
        decision,
        status,
        payloadHash: `${uniqueId()}`.padEnd(64, '0').slice(0, 64),
        policySnapshot: {},
      },
    });
  };

  const frequencyHit = (body: { reasons: { code: string }[] }): boolean =>
    body.reasons.some((r) => r.code === 'FREQUENCY');

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

  beforeEach(async () => {
    // The seed creates expenses for emp-7 and others; these tests use their
    // own employee ids, so only rows created here are ever in scope.
    await prisma.ruleHit.deleteMany({
      where: { expense: { employeeId: { startsWith: 'emp-window' } } },
    });
    await prisma.review.deleteMany({
      where: { expense: { employeeId: { startsWith: 'emp-window' } } },
    });
    await prisma.expense.deleteMany({ where: { employeeId: { startsWith: 'emp-window' } } });
  });

  // --- F04-T16 / T17: the lower boundary -----------------------------------
  it('F04-T16: an expense exactly at the lower boundary is included', async () => {
    // Window for an expense at t is [t - 60min, t]. A row at exactly
    // t - 60min is IN, because the bound is inclusive.
    await given(at(-60));
    await given(at(-30));
    await given(at(-10));

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    // 3 existing + this one = 4 > 3.
    expect(response.body.decision).toBe('REVIEW');
    expect(frequencyHit(response.body)).toBe(true);
    expect(
      response.body.reasons.find((r: { code: string }) => r.code === 'FREQUENCY').detail,
    ).toEqual({ windowMinutes: 60, maxCount: 3, countIncludingCurrent: 4 });
  });

  it('F04-T17: an expense one millisecond outside the lower boundary is excluded', async () => {
    // The same three rows, with the oldest moved back by 1ms. The column is
    // Timestamptz(3), so a millisecond is representable and this is a real
    // distinction rather than a rounding artefact.
    await given(at(-60, -1));
    await given(at(-30));
    await given(at(-10));

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    // 2 in window + this one = 3, which is not greater than 3.
    expect(response.body.decision).toBe('APPROVE');
    expect(response.body.reasons).toEqual([]);
  });

  // --- F04-T18: the upper boundary -----------------------------------------
  it('F04-T18: expenses after the current spentAt are excluded', async () => {
    // Three expenses that happened LATER than the one being evaluated. The
    // window looks backward only, so none of them counts.
    await given(at(10));
    await given(at(20));
    await given(at(30));

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    expect(response.body.decision).toBe('APPROVE');
  });

  it('F04-T18b: an expense at exactly the same instant is included', async () => {
    await given(at(0));
    await given(at(0));
    await given(at(0));

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    expect(response.body.decision).toBe('REVIEW');
  });

  // --- F04-T19 / T20: scoping ----------------------------------------------
  it('F04-T19: another employee in the same company does not count', async () => {
    await given(at(-30), { employeeId: 'emp-window-other' });
    await given(at(-20), { employeeId: 'emp-window-other' });
    await given(at(-10), { employeeId: 'emp-window-other' });

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    expect(response.body.decision).toBe('APPROVE');
  });

  it('F04-T20: another company with the SAME employeeId does not count', async () => {
    // The sharpest tenancy case for this rule: identical employee identifier,
    // different company. Without the companyId filter one company's traffic
    // would push another company's employees over their threshold.
    await given(at(-30), { companyId: COMPANY_B.id });
    await given(at(-20), { companyId: COMPANY_B.id });
    await given(at(-10), { companyId: COMPANY_B.id });

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    expect(response.body.decision).toBe('APPROVE');
  });

  // --- F04-T21 / T22: A2, every decision counts ----------------------------
  it('F04-T21: rejected expenses in the window still count', async () => {
    await given(at(-30), { decision: 'REJECT' });
    await given(at(-20), { decision: 'REJECT' });
    await given(at(-10), { decision: 'REJECT' });

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    // A2: the rule measures behaviour, not approvals. If rejected expenses
    // did not count, an employee could reset their own window by submitting
    // something certain to be rejected.
    expect(response.body.decision).toBe('REVIEW');
    expect(frequencyHit(response.body)).toBe(true);
  });

  it('F04-T22: expenses pending review still count', async () => {
    await given(at(-30), { decision: 'REVIEW' });
    await given(at(-20), { decision: 'REVIEW' });
    await given(at(-10), { decision: 'REVIEW' });

    const response = await submit({ spentAt: at(0).toISOString() }).expect(201);

    expect(response.body.decision).toBe('REVIEW');
  });

  // --- F04-T23: a retry contributes nothing --------------------------------
  it('F04-T23: an identical retry adds nothing to the window', async () => {
    const externalId = uniqueId();
    const body = { externalId, spentAt: at(0).toISOString() };

    await submit(body).expect(201);
    await submit(body).expect(200);
    await submit(body).expect(200);

    // Three requests, one row. If a retry contributed, a fourth distinct
    // expense would now trip the rule - it must not.
    expect(await prisma.expense.count({ where: { employeeId: 'emp-window' } })).toBe(1);

    await given(at(5));
    await given(at(6));

    const fourth = await submit({ spentAt: at(10).toISOString() }).expect(201);

    // 3 real rows + this one = 4. Had the two retries counted, this would
    // have been the sixth.
    expect(fourth.body.decision).toBe('REVIEW');
    expect(
      fourth.body.reasons.find((r: { code: string }) => r.code === 'FREQUENCY').detail
        .countIncludingCurrent,
    ).toBe(4);
  });

  // --- F04-T24 / T25: out-of-order, the ACCEPTED limitation ----------------
  it('F04-T24: a late expense is judged by its OWN backward window', async () => {
    // E1 10:10, E2 10:20, E3 10:30 - then E4 arrives late with spentAt 10:05.
    await given(at(10));
    await given(at(20));
    await given(at(30));

    const late = await submit({ spentAt: at(5).toISOString() }).expect(201);

    // E4's window is [09:05, 10:05]. E1, E2 and E3 all happened AFTER 10:05,
    // so none of them is inside it. Count is 1. APPROVE.
    //
    // This is risk R-11, and it is ACCEPTED rather than mitigated: forward-
    // only evaluation never looks ahead, so a back-dated expense can be
    // approved even though it is logically the fourth in its own window. The
    // advisory lock does not help with this and is not claimed to - the lock
    // orders concurrent writers, which is a different problem entirely.
    expect(late.body.decision).toBe('APPROVE');
    expect(late.body.reasons).toEqual([]);

    // And the decisions already made are NOT revisited.
    const earlier = await prisma.expense.findMany({
      where: { employeeId: 'emp-window', spentAt: { gte: at(10) } },
    });
    expect(earlier.every((e) => e.decision === 'APPROVE')).toBe(true);
  });

  it('F04-T25: the late expense DOES count for everything submitted after it', async () => {
    await given(at(10));
    await given(at(20));
    await given(at(30));
    await submit({ spentAt: at(5).toISOString() }).expect(201);

    // E5 at 10:35. Its window [09:35, 10:35] contains all four plus itself.
    const next = await submit({ spentAt: at(35).toISOString() }).expect(201);

    expect(next.body.decision).toBe('REVIEW');
    expect(
      next.body.reasons.find((r: { code: string }) => r.code === 'FREQUENCY').detail
        .countIncludingCurrent,
    ).toBe(5);

    // Late data is not discarded. It is simply never applied retroactively.
  });

  // --- the query plan, measured rather than asserted -----------------------
  it('the frequency query plan, on representative data', async () => {
    // The index `(companyId, employeeId, spentAt)` exists and has the range
    // column last, which is the shape a range scan needs. That does NOT mean
    // PostgreSQL will choose it - on a small table a sequential scan is
    // genuinely cheaper and the planner is right to take it.
    //
    // So this measures rather than claims. It loads enough rows for the index
    // to be the better plan, then prints what the planner actually did.
    const rows = Array.from({ length: 4_000 }, (_, i) => ({
      companyId: i % 2 === 0 ? COMPANY_A.id : COMPANY_B.id,
      externalId: `plan-${i}`,
      employeeId: `emp-plan-${i % 50}`,
      amountMinor: 1_000,
      currency: 'SAR',
      merchant: 'City Taxi',
      category: 'TRANSPORT',
      spentAt: new Date(BASE.getTime() - i * 60_000),
      decision: 'APPROVE' as const,
      status: 'APPROVED' as const,
      payloadHash: `plan-${i}`.padEnd(64, '0'),
      policySnapshot: {},
    }));

    await prisma.expense.createMany({ data: rows });
    await prisma.$executeRawUnsafe('ANALYZE "expenses"');

    const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM "expenses"
       WHERE "companyId" = $1 AND "employeeId" = $2
         AND "spentAt" >= $3 AND "spentAt" <= $4`,
      COMPANY_A.id,
      'emp-plan-0',
      new Date(BASE.getTime() - 60 * 60_000),
      BASE,
    );

    const text = plan.map((row) => row['QUERY PLAN']).join('\n');

    // Printed so the plan is visible in the test output and can be pasted
    // into the matrix rather than described from memory.
    console.log(`\n--- EXPLAIN ANALYZE, frequency query, 4000 rows ---\n${text}\n`);

    // The assertion is deliberately weak: that the composite index was used.
    // Asserting a specific node type would make this test fail on a future
    // PostgreSQL that picks an equally correct plan.
    expect(text).toContain('expenses_companyId_employeeId_spentAt_idx');

    await prisma.expense.deleteMany({ where: { externalId: { startsWith: 'plan-' } } });
  }, 60_000);
});
