import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { normaliseExpense, payloadHashOf } from '../../src/expenses/canonical-payload';
import { resetDatabase } from '../test-db';
import { createExpensesTestApp } from './expenses-test-app';
import { TestPolicyEvaluator } from './test-policy-evaluator';

/**
 * F03-T13, T14, T20, T23, T25 - sequential idempotency.
 *
 * The distinction these tests exist to pin down:
 *
 *   REQUEST IDEMPOTENCY is a property of the API. The same request, repeated,
 *   produces the same OBSERVABLE OUTCOME - the same decision, no second
 *   review, nothing added to a future frequency window.
 *
 *   DATABASE UNIQUENESS is a property of the table. No two rows share
 *   (companyId, externalId). It is a necessary mechanism, not the guarantee
 *   itself: a service could satisfy the constraint and still break idempotency
 *   by returning 500 on the second attempt, or by re-evaluating the policy.
 */
describe('F03 idempotency', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let evaluator: TestPolicyEvaluator;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const deltaKey = API_KEYS.find((k) => k.companyId === COMPANY_B.id)!.plaintext;

  const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    externalId: 'exp-idem',
    employeeId: 'emp-7',
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
    evaluator = new TestPolicyEvaluator().returning({
      decision: 'REVIEW',
      ruleHits: [{ ruleCode: 'AMOUNT_LIMIT', decision: 'REVIEW', detail: { limitMinor: 50_000 } }],
    });

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
  });

  // --- F03-T13 -------------------------------------------------------------
  it('F03-T13: an identical retry creates nothing and returns the original', async () => {
    const body = valid({ externalId: 'exp-t13' });

    const first = await post(body).expect(201);
    const second = await post(body).expect(200);

    // Same expense, not a new one.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.duplicate).toBe(true);
    expect(first.body.duplicate).toBe(false);

    // The ORIGINAL decision, unchanged.
    expect(second.body.decision).toBe(first.body.decision);
    expect(second.body.reasons).toEqual(first.body.reasons);

    const rows = await prisma.expense.findMany({ where: { externalId: 'exp-t13' } });
    expect(rows).toHaveLength(1);
  });

  it('F03-T13b: the retry does not re-evaluate the policy', async () => {
    // The sharp assertion. An implementation that re-ran the evaluator and
    // happened to get the same answer would pass every test above and still
    // be wrong: it would have counted the retry toward the frequency window,
    // and the decision would change the moment the policy changed (A7).
    const body = valid({ externalId: 'exp-t13b' });

    await post(body).expect(201);
    expect(evaluator.calls).toHaveLength(1);

    await post(body).expect(200);
    await post(body).expect(200);

    expect(evaluator.calls).toHaveLength(1);
  });

  it('F03-T13c: the retry creates no second review and no second rule hit', async () => {
    const body = valid({ externalId: 'exp-t13c' });

    const first = await post(body).expect(201);
    await post(body).expect(200);
    await post(body).expect(200);

    const expenseId = first.body.id as string;

    expect(await prisma.ruleHit.count({ where: { expenseId } })).toBe(1);
    expect(await prisma.review.count({ where: { expenseId } })).toBe(1);
  });

  it('F03-T13d: an equivalent body in a different shape is still a retry', async () => {
    // Different key order, a lowercase currency, a padded category, an offset
    // timestamp of the same instant. All formatting, no business difference.
    await post(valid({ externalId: 'exp-t13d' })).expect(201);

    await post({
      spentAt: '2026-11-20T12:15:00.000+03:00',
      category: '  transport  ',
      merchant: 'City  Taxi',
      currency: 'sar',
      amount: 12_500,
      employeeId: 'emp-7',
      externalId: 'exp-t13d',
    }).expect(200);

    expect(await prisma.expense.count({ where: { externalId: 'exp-t13d' } })).toBe(1);
  });

  // --- F03-T14 -------------------------------------------------------------
  it('F03-T14: the same externalId with a different payload is a 409', async () => {
    const body = valid({ externalId: 'exp-t14' });

    const first = await post(body).expect(201);
    const conflict = await post({ ...body, amount: 20_000 }).expect(409);

    expect(conflict.body.error).toBe('conflict');
    expect(conflict.body.details.conflictingField).toBe('externalId');
    expect(conflict.body.details.existing.id).toBe(first.body.id);
    expect(conflict.body.details.existing.decision).toBe('REVIEW');

    // The stored row is untouched. Not merely "a row exists" - the ORIGINAL
    // amount, because an upsert would have satisfied a weaker assertion.
    const row = await prisma.expense.findUniqueOrThrow({ where: { id: first.body.id as string } });
    expect(row.amountMinor).toBe(12_500);
    expect(row.decision).toBe('REVIEW');
    expect(await prisma.expense.count({ where: { externalId: 'exp-t14' } })).toBe(1);
  });

  it.each([
    ['amount', { amount: 12_501 }],
    ['employeeId', { employeeId: 'emp-8' }],
    ['merchant', { merchant: 'Desert Taxi' }],
    ['category', { category: 'MEALS' }],
    ['spentAt', { spentAt: '2026-11-20T09:15:01.000Z' }],
  ])('F03-T14b: a changed %s is a conflict, not a retry', async (field, override) => {
    const externalId = `exp-t14-${field}`;

    await post(valid({ externalId })).expect(201);
    await post(valid({ externalId, ...override })).expect(409);

    expect(await prisma.expense.count({ where: { externalId } })).toBe(1);
  });

  it('F03-T14c: the conflict response carries no payload hash', async () => {
    const externalId = 'exp-t14c';

    await post(valid({ externalId })).expect(201);
    const conflict = await post(valid({ externalId, amount: 99_999 })).expect(409);

    // Publishing the stored hash would let a caller brute-force the payload of
    // an expense they cannot otherwise read, one guess at a time.
    expect(JSON.stringify(conflict.body)).not.toMatch(/[0-9a-f]{64}/u);
  });

  it('F03-T14d: the conflict does not re-evaluate the policy', async () => {
    const externalId = 'exp-t14d';

    await post(valid({ externalId })).expect(201);
    expect(evaluator.calls).toHaveLength(1);

    await post(valid({ externalId, amount: 77_000 })).expect(409);
    expect(evaluator.calls).toHaveLength(1);
  });

  // --- F03-T20: tenant scoping --------------------------------------------
  it('F03-T20: the same externalId in two companies is two expenses', async () => {
    const body = valid({ externalId: 'exp-shared-id' });

    const a = await post(body, nileKey).expect(201);
    // Company B uses SAR too, so the payload is valid for both.
    const b = await post(body, deltaKey).expect(201);

    expect(a.body.id).not.toBe(b.body.id);
    expect(b.body.duplicate).toBe(false);

    const rows = await prisma.expense.findMany({
      where: { externalId: 'exp-shared-id' },
      orderBy: { companyId: 'asc' },
    });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.companyId))).toEqual(new Set([COMPANY_A.id, COMPANY_B.id]));
  });

  it('F03-T20b: one company cannot conflict with another company', async () => {
    // Company A's row must be invisible to company B's uniqueness check: if
    // the constraint were on externalId alone, this would be a 409 and one
    // tenant could block identifiers in another.
    await post(valid({ externalId: 'exp-no-cross', amount: 10_000 }), nileKey).expect(201);
    await post(valid({ externalId: 'exp-no-cross', amount: 20_000 }), deltaKey).expect(201);

    expect(await prisma.expense.count({ where: { externalId: 'exp-no-cross' } })).toBe(2);
  });

  // --- F03-T23 -------------------------------------------------------------
  it('F03-T23: a retry after a lost response returns the existing expense', async () => {
    // The scenario the whole feature exists for: the write committed, the
    // response never arrived, the caller retries. Indistinguishable from
    // F03-T13 from the server's side - which is the point. There is no state
    // that says "the response was delivered", and there should not be.
    const body = valid({ externalId: 'exp-t23' });

    const original = await post(body).expect(201);
    const retry = await post(body).expect(200);

    expect(retry.body.id).toBe(original.body.id);
    expect(retry.body.decision).toBe(original.body.decision);
    expect(retry.body.receivedAt).toBe(original.body.receivedAt);
    expect(await prisma.expense.count({ where: { externalId: 'exp-t23' } })).toBe(1);
  });

  // --- F03-T25: the validation ordering ------------------------------------
  it('F03-T25: a retry still works after the submission window has passed', async () => {
    // An expense accepted when it was fresh, retried once it is 91 days old.
    //
    // Shape validation passes, because it is time-independent by design. The
    // idempotency lookup then runs BEFORE the A4 window check, so the original
    // decision is returned. With the two steps in the other order this would
    // be a 422 for a rule the original submission satisfied, and the caller
    // could never stop retrying.
    const externalId = 'exp-t25';
    const stale = new Date(Date.now() - 95 * 24 * 3_600_000);

    // Seeded directly, because the API would refuse to CREATE one this old -
    // which is correct, and is exactly why the row has to arrive another way.
    const original = await prisma.expense.create({
      data: {
        companyId: COMPANY_A.id,
        externalId,
        employeeId: 'emp-7',
        amountMinor: 12_500,
        currency: 'SAR',
        merchant: 'City Taxi',
        category: 'TRANSPORT',
        spentAt: stale,
        decision: 'APPROVE',
        status: 'APPROVED',
        // The hash the service will compute for the same body.
        payloadHash: hashFor('emp-7', 12_500, 'SAR', 'City Taxi', 'TRANSPORT', stale),
        policySnapshot: {},
      },
    });

    const retry = await post(valid({ externalId, spentAt: stale.toISOString() })).expect(200);

    expect(retry.body.id).toBe(original.id);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.decision).toBe('APPROVE');
  });

  it('F03-T25b: a NEW expense that old is still refused', async () => {
    // The mirror image, so the ordering above cannot be mistaken for the A4
    // rule having been weakened. It applies in full to anything new.
    const response = await post(
      valid({
        externalId: 'exp-t25b',
        spentAt: new Date(Date.now() - 95 * 24 * 3_600_000).toISOString(),
      }),
    ).expect(422);

    expect(response.body.error).toBe('spent_at_too_old');
    expect(await prisma.expense.count({ where: { externalId: 'exp-t25b' } })).toBe(0);
  });

  it('F03-T25c: a conflicting resubmission of a stale expense is still a 409', async () => {
    // Not a 422. The idempotency decision is reached first, and "this
    // identifier is already taken by different facts" is the more useful
    // answer - telling the caller their timestamp is old would send them
    // looking in the wrong place entirely.
    const externalId = 'exp-t25c';
    const stale = new Date(Date.now() - 95 * 24 * 3_600_000);

    await prisma.expense.create({
      data: {
        companyId: COMPANY_A.id,
        externalId,
        employeeId: 'emp-7',
        amountMinor: 12_500,
        currency: 'SAR',
        merchant: 'City Taxi',
        category: 'TRANSPORT',
        spentAt: stale,
        decision: 'APPROVE',
        status: 'APPROVED',
        payloadHash: 'a'.repeat(64),
        policySnapshot: {},
      },
    });

    const response = await post(valid({ externalId, spentAt: stale.toISOString() })).expect(409);

    expect(response.body.error).toBe('conflict');
  });
});

/**
 * The PRODUCTION canonicalisation, used to build the fixture row.
 *
 * Deliberately not a hand-written hash: the fixture has to agree with whatever
 * the service computes, so that F03-T25 tests the retry path rather than
 * testing that two different hashing implementations happen to match.
 */
function hashFor(
  employeeId: string,
  amountMinor: number,
  currency: string,
  merchant: string,
  category: string,
  spentAt: Date,
): string {
  return payloadHashOf(
    normaliseExpense({ employeeId, amountMinor, currency, merchant, category, spentAt }),
  );
}
