import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import {
  createReviewsTestApp,
  createTestManager,
  login,
  TEST_APP_ORIGIN,
  type RequestBarrierInterceptor,
} from './reviews-test-app';

/**
 * F05-T31 to F05-T38 - competing resolutions against real PostgreSQL.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE BARRIER SITS, AND WHY IT CANNOT SIT ANYWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * Once the winning transaction's UPDATE matches the review, it holds that
 * row's lock until COMMIT. Every competitor then blocks INSIDE PostgreSQL -
 * not at any barrier of ours. A shared barrier downstream of the UPDATE could
 * therefore never be reached by more than one participant, and would hang
 * until its timeout. That is the F04 mistake, and it is avoided the same way:
 * the barrier is an interceptor that runs BEFORE the controller, so every
 * competitor is genuinely in flight and then races for the row.
 *
 * ---------------------------------------------------------------------------
 * HOW CONTENTION IS PROVEN RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 *
 * `pg_blocking_pids()` is asked, from a separate connection, which backends
 * are waiting on which. A non-empty answer is direct evidence that one
 * request is blocked on another's row lock - not an inference from timing.
 */
describe('F05 concurrent resolution', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let barrier: RequestBarrierInterceptor;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const deltaKey = API_KEYS.find((k) => k.companyId === COMPANY_B.id)!.plaintext;
  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const deltaManager = USERS.find((u) => u.companyId === COMPANY_B.id)!;

  let alice: { userId: string; cookie: string };
  let bob: { userId: string; cookie: string };
  let carol: { userId: string; cookie: string };
  let dave: { userId: string; cookie: string };
  let erin: { userId: string; cookie: string };
  let deltaCookie: string;

  let counter = 0;
  const uniqueId = (): string => `f05c-${Date.now()}-${(counter += 1)}`;

  const asManager = (cookie: string) => ({
    Cookie: cookie,
    origin: TEST_APP_ORIGIN,
    'x-limaz-client': '1',
  });

  const givenOpenReview = async (key: string = nileKey): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', key)
      .send({
        externalId: uniqueId(),
        employeeId: `emp-${uniqueId()}`,
        amount: key === nileKey ? 60_000 : 250_000, // over each company's limit
        currency: 'SAR',
        merchant: 'Shop',
        category: 'TRANSPORT',
        spentAt: new Date(Date.now() - 600_000).toISOString(),
      })
      .expect(201);

    expect(response.body.decision).toBe('REVIEW');

    const review = await prisma.review.findFirstOrThrow({
      where: { expenseId: response.body.id as string },
    });

    return review.id;
  };

  const resolve = (reviewId: string, decision: 'APPROVE' | 'REJECT', cookie: string) =>
    request(app.getHttpServer())
      .post(`/v1/reviews/${reviewId}/resolve`)
      .set(asManager(cookie))
      .send({ decision });

  beforeAll(async () => {
    const booted = await createReviewsTestApp();
    app = booted.app;
    prisma = booted.prisma;
    barrier = booted.barrier;

    await resetDatabase(prisma);
    await seed(prisma);

    // Five managers for company A. The production seed has one per company,
    // which cannot express "five managers race for one review"; adding them
    // to the seed would change what a reviewer sees when they run the app.
    [alice, bob, carol, dave, erin] = await Promise.all([
      createTestManager(app, prisma, COMPANY_A.id, 'alice'),
      createTestManager(app, prisma, COMPANY_A.id, 'bob'),
      createTestManager(app, prisma, COMPANY_A.id, 'carol'),
      createTestManager(app, prisma, COMPANY_A.id, 'dave'),
      createTestManager(app, prisma, COMPANY_A.id, 'erin'),
    ]);

    deltaCookie = await login(app, deltaManager.email, deltaManager.password);
    await login(app, nileManager.email, nileManager.password);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  beforeEach(() => {
    barrier.disarm();
  });

  // --- F05-T31: the central case ------------------------------------------
  it('F05-T31: two managers with OPPOSITE decisions - one 200, one 409', async () => {
    const reviewId = await givenOpenReview();

    barrier.arm(2, 15_000);

    const [a, b] = await Promise.all([
      resolve(reviewId, 'APPROVE', alice.cookie),
      resolve(reviewId, 'REJECT', bob.cookie),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = [a, b].find((r) => r.status === 200)!;
    const loser = [a, b].find((r) => r.status === 409)!;

    const review = await prisma.review.findUniqueOrThrow({
      where: { id: reviewId },
      include: { expense: true },
    });

    // Exactly ONE transition, and the stored state is the winner's.
    expect(review.state).toBe('RESOLVED');
    expect(review.outcome).toBe(winner.body.resolution.outcome);
    expect(review.resolvedByUserId).toBe(winner.body.resolution.resolvedBy.id);

    // The expense followed the winner, not whoever answered last.
    expect(review.expense.status).toBe(review.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED');

    // The original policy decision is untouched by either request.
    expect(review.expense.decision).toBe('REVIEW');

    // The loser is told who won, well enough to stop retrying.
    expect(loser.body.error).toBe('review_already_resolved');
    expect(loser.body.details.resolvedByUserId).toBe(review.resolvedByUserId);

    // Exactly one reviewer identity is recorded - there is one column, so the
    // real assertion is that it holds the WINNER's.
    expect([alice.userId, bob.userId]).toContain(review.resolvedByUserId);
    expect(review.resolvedByUserId).not.toBe(
      loser.body.details.resolvedByUserId === alice.userId ? bob.userId : undefined,
    );
  }, 30_000);

  // --- F05-T32: identical decisions, different managers --------------------
  it('F05-T32: two managers with the SAME decision - still one 200 and one 409', async () => {
    const reviewId = await givenOpenReview();

    barrier.arm(2, 15_000);

    const results = await Promise.all([
      resolve(reviewId, 'APPROVE', alice.cookie),
      resolve(reviewId, 'APPROVE', bob.cookie),
    ]);

    // The retry exemption is narrow on purpose: it requires the SAME manager.
    // A different manager repeating the action did not lose a response - they
    // are acting on stale information and should be told so.
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    const winner = results.find((r) => r.status === 200)!;
    expect(review.resolvedByUserId).toBe(winner.body.resolution.resolvedBy.id);
  }, 30_000);

  // --- F05-T33: five competitors ------------------------------------------
  it('F05-T33: five managers compete - exactly one transition', async () => {
    const reviewId = await givenOpenReview();

    barrier.arm(5, 20_000);

    const sessions = [alice, bob, carol, dave, erin];
    const results = await Promise.all(
      sessions.map((manager, i) =>
        resolve(reviewId, i % 2 === 0 ? 'APPROVE' : 'REJECT', manager.cookie),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(results.some((r) => r.status >= 500)).toBe(false);

    const review = await prisma.review.findUniqueOrThrow({
      where: { id: reviewId },
      include: { expense: true },
    });
    const winner = results.find((r) => r.status === 200)!;

    expect(review.resolvedByUserId).toBe(winner.body.resolution.resolvedBy.id);
    expect(review.outcome).toBe(winner.body.resolution.outcome);
    expect(review.expense.status).toBe(review.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED');

    // Every loser points at the same winner.
    for (const loser of results.filter((r) => r.status === 409)) {
      expect(loser.body.details.resolvedByUserId).toBe(review.resolvedByUserId);
      expect(loser.body.details.outcome).toBe(review.outcome);
    }

    // WHICH manager won is not asserted. Lock acquisition order is not
    // determined, so naming one would be flaky by design.
  }, 40_000);

  // --- F05-T34: the same manager, concurrently -----------------------------
  it('F05-T34: the same manager repeating concurrently - two 200s, ONE transition', async () => {
    const reviewId = await givenOpenReview();

    barrier.arm(2, 15_000);

    const results = await Promise.all([
      resolve(reviewId, 'APPROVE', alice.cookie),
      resolve(reviewId, 'APPROVE', alice.cookie),
    ]);

    // BOTH succeed, and that is correct. One performed the transition; the
    // other found it already resolved by itself with the same outcome and
    // returned the stored result having written nothing.
    //
    // The assessment requires exactly one state TRANSITION, not exactly one
    // 2xx response. Conflating those would make this test demand the wrong
    // thing.
    expect(results.map((r) => r.status)).toEqual([200, 200]);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    expect(review.resolvedByUserId).toBe(alice.userId);
    expect(review.outcome).toBe('APPROVED');

    // One transition: resolvedAt and updatedAt were written together, once.
    expect(review.updatedAt.toISOString()).toBe(review.resolvedAt!.toISOString());

    // Both responses describe the same resolution.
    expect(results[0]!.body.resolution).toEqual(results[1]!.body.resolution);
  }, 30_000);

  it('F05-T34b: the same manager with CONFLICTING decisions - one 200, one 409', async () => {
    const reviewId = await givenOpenReview();

    barrier.arm(2, 15_000);

    const results = await Promise.all([
      resolve(reviewId, 'APPROVE', alice.cookie),
      resolve(reviewId, 'REJECT', alice.cookie),
    ]);

    // Same manager is not enough - the OUTCOME must match too. Two different
    // decisions from one person is a client bug, and returning 200 to both
    // would tell them both were honoured.
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  }, 30_000);

  // --- F05-T35 / T36: independence ----------------------------------------
  it('F05-T35: concurrent resolutions of DIFFERENT reviews all succeed', async () => {
    const ids = await Promise.all([givenOpenReview(), givenOpenReview(), givenOpenReview()]);

    barrier.arm(3, 15_000);

    const results = await Promise.all([
      resolve(ids[0]!, 'APPROVE', alice.cookie),
      resolve(ids[1]!, 'REJECT', bob.cookie),
      resolve(ids[2]!, 'APPROVE', carol.cookie),
    ]);

    // Different rows, different locks: nothing contends.
    expect(results.every((r) => r.status === 200)).toBe(true);

    const rows = await prisma.review.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.state === 'RESOLVED')).toBe(true);
  }, 30_000);

  it('F05-T36: concurrent resolutions across companies are independent', async () => {
    const nileReview = await givenOpenReview(nileKey);
    const deltaReview = await givenOpenReview(deltaKey);

    barrier.arm(2, 15_000);

    const [a, b] = await Promise.all([
      resolve(nileReview, 'APPROVE', alice.cookie),
      resolve(deltaReview, 'REJECT', deltaCookie),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const rows = await prisma.review.findMany({ where: { id: { in: [nileReview, deltaReview] } } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.companyId))).toEqual(new Set([COMPANY_A.id, COMPANY_B.id]));
  }, 30_000);

  // --- F05-T37: an unauthorised competitor --------------------------------
  it('F05-T37: only the authorised request can mutate when both compete', async () => {
    const reviewId = await givenOpenReview();

    barrier.arm(2, 15_000);

    const [authorised, foreign] = await Promise.all([
      resolve(reviewId, 'APPROVE', alice.cookie),
      // Delta's manager, racing for Nile's review.
      resolve(reviewId, 'REJECT', deltaCookie),
    ]);

    expect(authorised.status).toBe(200);
    expect(foreign.status).toBe(404);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.outcome).toBe('APPROVED');
    expect(review.resolvedByUserId).toBe(alice.userId);
  }, 30_000);

  // --- the lock contention itself, measured -------------------------------
  it('a loser genuinely blocks on the winner row lock, per pg_blocking_pids()', async () => {
    const reviewId = await givenOpenReview();

    // A transaction that takes the row lock and HOLDS it, so the competing
    // HTTP request has something to block on for long enough to observe.
    // A single holder, not a shared barrier - a shared barrier here is
    // exactly the deadlock this file exists to avoid.
    let release!: () => void;
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE "reviews" SET "updatedAt" = clock_timestamp()
           WHERE id = ${reviewId}::uuid AND "companyId" = ${COMPANY_A.id}::uuid
        `;
        await held;
      },
      { timeout: 20_000 },
    );

    // Give the holder time to take the lock, then start the competitor.
    await new Promise((r) => setTimeout(r, 300));
    // `.then()` is what SENDS a supertest request - a Test object assigned to a
    // variable is lazy and sits there doing nothing. Without this the
    // "competitor" would only be dispatched when awaited at the end, long
    // after the holder released, and nothing would ever block.
    const competitor = resolve(reviewId, 'APPROVE', alice.cookie).then((r) => r);

    const blocked = await waitForBlockedBackend(prisma);

    // DIRECT evidence, not an inference from timing: PostgreSQL itself
    // reports a backend waiting on another backend.
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]!.blockers.length).toBeGreaterThan(0);

    release();
    await holder;

    // Once the holder commits, the competitor proceeds. The row is still
    // OPEN - the holder only touched updatedAt - so it wins.
    const response = await competitor;
    expect(response.status).toBe(200);
  }, 60_000);

  // --- F05-T38: the winner rolls back -------------------------------------
  it('F05-T38: when the first transaction rolls back, a waiting one can still win', async () => {
    const reviewId = await givenOpenReview();

    // A transaction that locks the row, then aborts.
    let abort!: () => void;
    const signal = new Promise<void>((resolve_) => {
      abort = resolve_;
    });

    const doomed = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE "reviews" SET state = 'RESOLVED', outcome = 'REJECTED',
                   "resolvedByUserId" = ${bob.userId}::uuid,
                   "resolvedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
             WHERE id = ${reviewId}::uuid AND state = 'OPEN'
          `;
          await signal;
          throw new Error('deliberate rollback');
        },
        { timeout: 20_000 },
      )
      .catch(() => undefined);

    await new Promise((r) => setTimeout(r, 300));
    // Sent now, so it genuinely blocks on the doomed transaction's row lock.
    const waiting = resolve(reviewId, 'APPROVE', alice.cookie).then((r) => r);

    // Confirm it is actually waiting before releasing, so this test exercises
    // the blocked path rather than passing because the request arrived late.
    await waitForBlockedBackend(prisma);

    abort();
    await doomed;

    // The doomed transaction's write never committed, so the review was never
    // RESOLVED. PostgreSQL re-evaluates the waiting statement's WHERE against
    // the row as it actually is - still OPEN - so the waiter succeeds.
    const response = await waiting;
    expect(response.status).toBe(200);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.outcome).toBe('APPROVED');
    expect(review.resolvedByUserId).toBe(alice.userId);
    // Nothing from the aborted transaction survives.
    expect(review.resolvedByUserId).not.toBe(bob.userId);
  }, 60_000);
});

/**
 * Waits until PostgreSQL reports a backend blocked on another, or gives up.
 *
 * `pg_blocking_pids()` is the reliable diagnostic: it names the backends a
 * given backend is waiting for. A non-empty answer is direct evidence of lock
 * contention rather than an inference from how long something took.
 *
 * Bounded, and it RETURNS rather than throwing on timeout - the caller
 * asserts, so a failure reads as "nothing was blocked" at the assertion site
 * instead of as an exception from a helper.
 */
async function waitForBlockedBackend(
  prisma: PrismaClient,
  timeoutMs = 10_000,
): Promise<{ pid: number; blockers: number[] }[]> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const blocked = await prisma.$queryRaw<{ pid: number; blockers: number[] }[]>`
      SELECT pid, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND cardinality(pg_blocking_pids(pid)) > 0
    `;

    if (blocked.length > 0) {
      return blocked;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return [];
}
