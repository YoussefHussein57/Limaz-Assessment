import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import {
  createReviewsTestApp,
  createTestManager,
  login,
  TEST_APP_ORIGIN,
} from './reviews-test-app';

/**
 * F05-T21 to F05-T30, T39 to T44 - resolution, audit and historical integrity.
 *
 * Reviews are created the way production creates them - by submitting an
 * expense that trips a policy rule - rather than inserted by hand. An
 * inserted fixture can drift from what the submission path actually writes,
 * and then the tests pass against a shape that never occurs.
 */
describe('F05 review resolution', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;

  let cookie: string;
  let managerId: string;
  let second: { userId: string; cookie: string };

  let counter = 0;
  const uniqueId = (): string => `f05-${Date.now()}-${(counter += 1)}`;

  const asManager = (session: string) => ({
    Cookie: session,
    origin: TEST_APP_ORIGIN,
    'x-limaz-client': '1',
  });

  /** Submits an expense that trips the amount rule, and returns its review. */
  const givenOpenReview = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{
    reviewId: string;
    expenseId: string;
    externalId: string;
    body: Record<string, unknown>;
  }> => {
    const body = {
      externalId: uniqueId(),
      employeeId: `emp-${uniqueId()}`,
      amount: 60_000, // over company A's 50,000 limit
      currency: 'SAR',
      merchant: 'Shop',
      category: 'TRANSPORT',
      spentAt: new Date(Date.now() - 600_000).toISOString(),
      ...overrides,
    };

    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send(body)
      .expect(201);

    expect(response.body.decision).toBe('REVIEW');

    const review = await prisma.review.findFirstOrThrow({
      where: { expenseId: response.body.id as string },
    });

    return {
      reviewId: review.id,
      expenseId: response.body.id as string,
      externalId: body.externalId as string,
      body,
    };
  };

  const resolve = (reviewId: string, decision: 'APPROVE' | 'REJECT', session = cookie) =>
    request(app.getHttpServer())
      .post(`/v1/reviews/${reviewId}/resolve`)
      .set(asManager(session))
      .send({ decision });

  beforeAll(async () => {
    const booted = await createReviewsTestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    cookie = await login(app, nileManager.email, nileManager.password);
    managerId = (await prisma.user.findUniqueOrThrow({ where: { email: nileManager.email } })).id;
    second = await createTestManager(app, prisma, COMPANY_A.id, 'second-manager');
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  // --- F05-T21 / T22: the happy paths --------------------------------------
  it('F05-T21: approving an open review sets both states', async () => {
    const { reviewId, expenseId } = await givenOpenReview();

    const response = await resolve(reviewId, 'APPROVE').expect(200);

    expect(response.body.state).toBe('RESOLVED');
    expect(response.body.resolution.outcome).toBe('APPROVED');

    const [review, expense] = await Promise.all([
      prisma.review.findUniqueOrThrow({ where: { id: reviewId } }),
      prisma.expense.findUniqueOrThrow({ where: { id: expenseId } }),
    ]);

    expect(review.state).toBe('RESOLVED');
    expect(review.outcome).toBe('APPROVED');
    expect(expense.status).toBe('APPROVED');
  });

  it('F05-T22: rejecting an open review sets both states', async () => {
    const { reviewId, expenseId } = await givenOpenReview();

    const response = await resolve(reviewId, 'REJECT').expect(200);

    expect(response.body.resolution.outcome).toBe('REJECTED');

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.status).toBe('REJECTED');
  });

  // --- F05-T23: the audit record -------------------------------------------
  it('F05-T23: the resolution records who, what and when', async () => {
    const { reviewId } = await givenOpenReview();

    const before = Date.now();
    const response = await resolve(reviewId, 'APPROVE').expect(200);
    const after = Date.now();

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    // The reviewer comes from the SESSION. Nothing in the request could have
    // named them - the DTO refuses any such field.
    expect(review.resolvedByUserId).toBe(managerId);
    expect(response.body.resolution.resolvedBy.id).toBe(managerId);

    // The timestamp comes from PostgreSQL's clock_timestamp(), so it is the
    // instant the UPDATE executed - not the transaction's start, which under
    // contention can be noticeably earlier.
    const resolvedAt = review.resolvedAt!.getTime();
    expect(resolvedAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(resolvedAt).toBeLessThanOrEqual(after + 1_000);

    // resolvedAt and updatedAt are written from ONE evaluation, so they
    // cannot disagree. Two separate clock_timestamp() calls would return two
    // different instants.
    expect(review.updatedAt.toISOString()).toBe(review.resolvedAt!.toISOString());

    // And it is after the review was created - which only holds because both
    // columns use the database clock. An application clock would make this
    // comparison meaningless, and under skew it could go negative.
    expect(resolvedAt).toBeGreaterThanOrEqual(review.createdAt.getTime());
  });

  // --- F05-T24 / T25: what resolution must NOT touch ----------------------
  it('F05-T24 / F05-T25: the original decision, rule hits and snapshot are untouched', async () => {
    const { reviewId, expenseId } = await givenOpenReview();

    const before = await prisma.expense.findUniqueOrThrow({
      where: { id: expenseId },
      include: { ruleHits: true },
    });

    await resolve(reviewId, 'REJECT').expect(200);

    const after = await prisma.expense.findUniqueOrThrow({
      where: { id: expenseId },
      include: { ruleHits: true },
    });

    // The policy said REVIEW. A human said REJECT. Those are two different
    // facts and the row carries both - merging them would lose the answer to
    // "what did the policy originally conclude?", which is a basic audit
    // question (ADR-004).
    expect(after.decision).toBe('REVIEW');
    expect(after.status).toBe('REJECTED');

    expect(after.policySnapshot).toEqual(before.policySnapshot);
    expect(after.payloadHash).toBe(before.payloadHash);
    expect(after.amountMinor).toBe(before.amountMinor);
    expect(after.spentAt.toISOString()).toBe(before.spentAt.toISOString());
    expect(after.receivedAt.toISOString()).toBe(before.receivedAt.toISOString());

    expect(after.ruleHits).toHaveLength(before.ruleHits.length);
    expect(after.ruleHits.map((h) => h.ruleCode).sort()).toEqual(
      before.ruleHits.map((h) => h.ruleCode).sort(),
    );
    expect(after.ruleHits.map((h) => h.detail)).toEqual(before.ruleHits.map((h) => h.detail));
  });

  // --- F05-T26 to T28: sequential repeats ---------------------------------
  /**
   * The transaction id that created the current version of a row.
   *
   * PostgreSQL does not update a row in place - every UPDATE writes a NEW row
   * version with a new `xmin`. So an unchanged `xmin` is conclusive proof
   * that no write touched the row, in a way comparing `updatedAt` is not: a
   * write that happened to store the same timestamp would leave `updatedAt`
   * identical while still having mutated the row.
   */
  const xminOf = async (reviewId: string): Promise<string> => {
    const rows = await prisma.$queryRaw<{ xmin: string }[]>`
      SELECT xmin::text AS xmin FROM "reviews" WHERE id = ${reviewId}::uuid
    `;

    return rows[0]!.xmin;
  };

  it('F05-T26: the same manager repeating the same decision gets 200 and writes nothing', async () => {
    const { reviewId } = await givenOpenReview();

    const first = await resolve(reviewId, 'APPROVE').expect(200);
    const snapshot = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    const xminBefore = await xminOf(reviewId);

    const retry = await resolve(reviewId, 'APPROVE').expect(200);

    expect(retry.body.resolution).toEqual(first.body.resolution);

    const after = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    // ZERO writes on the replay, proven by `xmin` rather than inferred from
    // equal values. PostgreSQL never updates in place: any UPDATE writes a
    // new row version with a new xmin. An unchanged xmin means no write
    // occurred - whereas identical `updatedAt` values would also be the
    // result of a write that happened to store the same timestamp.
    expect(await xminOf(reviewId)).toBe(xminBefore);

    // The values are asserted too, because xmin proves nothing was written
    // and these prove what is stored is still right.
    expect(after.resolvedAt!.toISOString()).toBe(snapshot.resolvedAt!.toISOString());
    expect(after.updatedAt.toISOString()).toBe(snapshot.updatedAt.toISOString());
    expect(after.resolvedByUserId).toBe(snapshot.resolvedByUserId);
    expect(after.outcome).toBe(snapshot.outcome);
  });

  it('F05-T26b: xmin DOES change on a real transition, so the check is not vacuous', async () => {
    // The control for the control. If xmin never changed, the assertion above
    // would pass whatever the service did.
    const { reviewId } = await givenOpenReview();

    const before = await xminOf(reviewId);
    await resolve(reviewId, 'APPROVE').expect(200);
    const after = await xminOf(reviewId);

    expect(after).not.toBe(before);
  });

  it('F05-T27: the same manager with a CONFLICTING decision gets 409', async () => {
    const { reviewId, expenseId } = await givenOpenReview();

    await resolve(reviewId, 'APPROVE').expect(200);

    const conflict = await resolve(reviewId, 'REJECT').expect(409);

    expect(conflict.body.error).toBe('review_already_resolved');
    expect(conflict.body.details.outcome).toBe('APPROVED');

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.status).toBe('APPROVED');
  });

  it('F05-T28: another manager cannot alter a resolved review, same decision or not', async () => {
    const { reviewId } = await givenOpenReview();

    await resolve(reviewId, 'APPROVE').expect(200);
    const snapshot = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    // Same outcome, different manager: still 409. The retry exemption is
    // narrow on purpose - it exists for a lost response, and a DIFFERENT
    // manager repeating the action did not lose a response, they are acting
    // on stale information and should be told so.
    const same = await resolve(reviewId, 'APPROVE', second.cookie).expect(409);
    expect(same.body.details.resolvedByUserId).toBe(managerId);

    await resolve(reviewId, 'REJECT', second.cookie).expect(409);

    const after = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(after.resolvedByUserId).toBe(snapshot.resolvedByUserId);
    expect(after.resolvedAt!.toISOString()).toBe(snapshot.resolvedAt!.toISOString());
    expect(after.outcome).toBe(snapshot.outcome);
  });

  // --- F05-T29: policy changes -------------------------------------------
  it('F05-T29: a policy change before resolution re-evaluates nothing', async () => {
    const { reviewId, expenseId } = await givenOpenReview();

    const original = await prisma.policy.findUniqueOrThrow({
      where: { companyId: COMPANY_A.id },
    });

    try {
      await prisma.policy.update({
        where: { companyId: COMPANY_A.id },
        data: { autoApproveLimitMinor: 5_000_000 },
      });

      await resolve(reviewId, 'APPROVE').expect(200);

      const expense = await prisma.expense.findUniqueOrThrow({
        where: { id: expenseId },
        include: { ruleHits: true },
      });

      // Resolution is a human act on a decision already made. It does not
      // consult the policy at all - so the snapshot, the rule hits and the
      // original decision are exactly what they were.
      expect(expense.decision).toBe('REVIEW');
      expect(expense.ruleHits).toHaveLength(1);
      expect(
        (expense.policySnapshot as { autoApproveLimitMinor: number }).autoApproveLimitMinor,
      ).toBe(original.autoApproveLimitMinor);
    } finally {
      await prisma.policy.update({
        where: { companyId: COMPANY_A.id },
        data: { autoApproveLimitMinor: original.autoApproveLimitMinor },
      });
    }
  });

  // --- F05-T30: the F03 contract survives ---------------------------------
  it('F05-T30: resubmitting the expense after resolution changes nothing', async () => {
    const { reviewId, expenseId, body } = await givenOpenReview();

    await resolve(reviewId, 'APPROVE').expect(200);

    const retry = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send(body)
      .expect(200);

    // The response carries BOTH facts, which is exactly why the F03 contract
    // needed no correction: `decision` is the immutable policy conclusion and
    // `status` is the current outcome.
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.id).toBe(expenseId);
    expect(retry.body.decision).toBe('REVIEW');
    expect(retry.body.status).toBe('APPROVED');

    // No second expense, no second review, no reopened review.
    expect(await prisma.expense.count({ where: { externalId: body.externalId as string } })).toBe(
      1,
    );
    expect(await prisma.review.count({ where: { expenseId } })).toBe(1);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.state).toBe('RESOLVED');
    expect(review.outcome).toBe('APPROVED');

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.status).toBe('APPROVED');
  });

  it('F05-T30b: the resolved expense still counts toward the frequency window', async () => {
    // A2 counts every expense regardless of decision, and a human resolution
    // must not change that - otherwise approving an expense would quietly
    // give the employee their window back.
    const employeeId = `emp-freq-${uniqueId()}`;
    const spentAt = new Date(Date.now() - 600_000).toISOString();

    const submit = (amount: number) =>
      request(app.getHttpServer())
        .post('/v1/expenses')
        .set('x-api-key', nileKey)
        .send({
          externalId: uniqueId(),
          employeeId,
          amount,
          currency: 'SAR',
          merchant: 'Shop',
          category: 'TRANSPORT',
          spentAt,
        })
        .expect(201);

    const over = await submit(60_000); // REVIEW on amount
    const review = await prisma.review.findFirstOrThrow({
      where: { expenseId: over.body.id as string },
    });
    await resolve(review.id, 'APPROVE').expect(200);

    await submit(1_000);
    await submit(1_000);
    const fourth = await submit(1_000);

    expect(fourth.body.decision).toBe('REVIEW');
    expect(
      fourth.body.reasons.find((r: { code: string }) => r.code === 'FREQUENCY').detail
        .countIncludingCurrent,
    ).toBe(4);
  });

  // --- F05-T39 to T44: failure and integrity ------------------------------
  it('F05-T39 / F05-T40: a failing expense update rolls the review back', async () => {
    const { reviewId, expenseId } = await givenOpenReview();

    // Move the expense out of PENDING_REVIEW behind the service's back. The
    // conditional expense update then matches zero rows, which must abort the
    // whole resolution rather than leave a resolved review pointing at an
    // expense that was never transitioned.
    await prisma.expense.update({
      where: { id: expenseId },
      data: { status: 'APPROVED' },
    });

    const response = await resolve(reviewId, 'APPROVE').expect(500);
    expect(response.body.error).toBe('internal_error');
    // No internal detail reaches the caller.
    expect(JSON.stringify(response.body)).not.toMatch(/expenses|reviews|rows/u);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    // THE REVIEW UPDATE WAS ROLLED BACK. Both writes are in one transaction,
    // so there is no moment at which the review is resolved while its expense
    // is not - that state only exists if the writes are split.
    expect(review.state).toBe('OPEN');
    expect(review.outcome).toBeNull();
    expect(review.resolvedByUserId).toBeNull();
    expect(review.resolvedAt).toBeNull();
  });

  it('F05-T42: a review remains resolvable after a failed attempt', async () => {
    const { reviewId, expenseId } = await givenOpenReview();

    await prisma.expense.update({ where: { id: expenseId }, data: { status: 'APPROVED' } });
    await resolve(reviewId, 'APPROVE').expect(500);

    // Put it back and try again - the earlier failure left nothing behind.
    await prisma.expense.update({
      where: { id: expenseId },
      data: { status: 'PENDING_REVIEW' },
    });

    const retry = await resolve(reviewId, 'REJECT').expect(200);
    expect(retry.body.resolution.outcome).toBe('REJECTED');

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.status).toBe('REJECTED');
  });

  it('F05-T43: a lost response is indistinguishable from a retry, and writes nothing', async () => {
    // The scenario the 200-on-retry exists for: the transaction committed and
    // the response never arrived. The server cannot tell this from an
    // ordinary repeat, and should not try.
    const { reviewId } = await givenOpenReview();

    await resolve(reviewId, 'APPROVE').expect(200);
    const snapshot = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    const xminBefore = await xminOf(reviewId);

    for (let i = 0; i < 3; i += 1) {
      await resolve(reviewId, 'APPROVE').expect(200);
    }

    const after = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    // One transition, three extra 200s, zero additional writes - proven by
    // the row version, not by equal timestamps.
    expect(await xminOf(reviewId)).toBe(xminBefore);
    expect(after.updatedAt.toISOString()).toBe(snapshot.updatedAt.toISOString());
    expect(after.resolvedAt!.toISOString()).toBe(snapshot.resolvedAt!.toISOString());
  });

  it('F05-T44: a resolved review cannot have its reviewer or timestamp overwritten', async () => {
    const { reviewId } = await givenOpenReview();

    await resolve(reviewId, 'APPROVE', second.cookie).expect(200);
    const snapshot = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    const xminBefore = await xminOf(reviewId);
    expect(snapshot.resolvedByUserId).toBe(second.userId);

    // Every shape of later attempt, from both managers.
    await resolve(reviewId, 'APPROVE').expect(409);
    await resolve(reviewId, 'REJECT').expect(409);
    await resolve(reviewId, 'REJECT', second.cookie).expect(409);

    const after = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    // Three refused attempts wrote NOTHING - the row version is untouched.
    expect(await xminOf(reviewId)).toBe(xminBefore);
    expect(after.resolvedByUserId).toBe(second.userId);
    expect(after.resolvedAt!.toISOString()).toBe(snapshot.resolvedAt!.toISOString());
    expect(after.outcome).toBe('APPROVED');
    expect(after.updatedAt.toISOString()).toBe(snapshot.updatedAt.toISOString());
  });

  it('a resolved review leaves the default listing', async () => {
    const { reviewId } = await givenOpenReview();

    const before = await request(app.getHttpServer())
      .get('/v1/reviews?limit=100')
      .set(asManager(cookie))
      .expect(200);

    expect(before.body.items.some((r: { id: string }) => r.id === reviewId)).toBe(true);

    await resolve(reviewId, 'APPROVE').expect(200);

    const after = await request(app.getHttpServer())
      .get('/v1/reviews?limit=100')
      .set(asManager(cookie))
      .expect(200);

    expect(after.body.items.some((r: { id: string }) => r.id === reviewId)).toBe(false);
  });
});
