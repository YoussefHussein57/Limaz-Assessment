import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { TEST_DATABASE_NAME } from '../database-url';
import { resetDatabase } from '../test-db';
import {
  createReviewsTestApp,
  createTestManager,
  TEST_APP_ORIGIN,
  type RequestBarrierInterceptor,
} from './reviews-test-app';

/**
 * F05-NC1 - the review resolution negative control.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES, PRECISELY
 * ---------------------------------------------------------------------------
 *
 * That `AND state = 'OPEN'` inside the UPDATE - rather than a check performed
 * in application memory first - is what makes exactly one resolution win.
 *
 * Without it, two managers both read OPEN, both pass their in-memory check,
 * and both write. The second overwrites the first's outcome, reviewer AND
 * timestamp. Nobody is told; the audit trail simply names the wrong person.
 *
 * It does NOT prove anything about transactions in general: both halves of
 * this experiment run in real transactions. A transaction gives atomicity and
 * isolation, not protection from a lost update - two transactions can read
 * the same row and both write it, because nothing conflicts until the writes
 * themselves and by then the decision was already made in memory.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS MADE DETERMINISTIC
 * ---------------------------------------------------------------------------
 *
 * Both transactions are forced to READ before either WRITES. That is the
 * ordering that produces the lost update, and it is the ordering a real race
 * hits intermittently. Forcing it turns "sometimes wrong" into "always
 * wrong", which is what a control needs.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 * ---------------------------------------------------------------------------
 *
 * The unsafe version is written out HERE, in the test, as raw SQL against the
 * test database. Nothing in `src/` is weakened and there is no flag, no
 * environment variable and no substituted provider that could disable the
 * predicate in a running application. The database name is asserted from the
 * live connection before anything runs.
 */
describe('F05 negative control', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let barrier: RequestBarrierInterceptor;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  let alice: { userId: string; cookie: string };
  let bob: { userId: string; cookie: string };

  let counter = 0;
  const uniqueId = (): string => `nc-${Date.now()}-${(counter += 1)}`;

  const givenOpenReview = async (): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send({
        externalId: uniqueId(),
        employeeId: `emp-${uniqueId()}`,
        amount: 60_000,
        currency: 'SAR',
        merchant: 'Shop',
        category: 'TRANSPORT',
        spentAt: new Date(Date.now() - 600_000).toISOString(),
      })
      .expect(201);

    const review = await prisma.review.findFirstOrThrow({
      where: { expenseId: response.body.id as string },
    });

    return review.id;
  };

  beforeAll(async () => {
    const booted = await createReviewsTestApp();
    app = booted.app;
    prisma = booted.prisma;
    barrier = booted.barrier;

    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;

    if (rows[0]?.name !== TEST_DATABASE_NAME) {
      throw new Error(
        `REFUSING TO RUN: this suite writes deliberately unsafe SQL and is connected to ` +
          `"${rows[0]?.name}", not "${TEST_DATABASE_NAME}".`,
      );
    }

    await resetDatabase(prisma);
    await seed(prisma);

    alice = await createTestManager(app, prisma, COMPANY_A.id, 'nc-alice');
    bob = await createTestManager(app, prisma, COMPANY_A.id, 'nc-bob');
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  it('F05-NC1: without the OPEN predicate, the second manager overwrites the first', async () => {
    const reviewId = await givenOpenReview();

    // Both transactions read first - the ordering that produces a lost update.
    const bothRead = gate(2);
    // ONE participant: Alice is the only one who signals this. Sizing it 2
    // was the first version, and it deadlocked - Bob waited for a second
    // arrival that was never coming.
    const aliceWrote = gate(1);

    /** Check-then-update, exactly as it would be written without the guard. */
    const unsafeResolve = async (
      userId: string,
      outcome: 'APPROVED' | 'REJECTED',
      coordinate: () => Promise<void>,
    ): Promise<number> =>
      prisma.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ state: string }[]>`
            SELECT state FROM "reviews" WHERE id = ${reviewId}::uuid
          `;

          // The in-memory check. It passes for BOTH, because neither has
          // written yet.
          if (row?.state !== 'OPEN') {
            return 0;
          }

          await coordinate();

          // The unsafe mutation: no `AND state = 'OPEN'`.
          return tx.$executeRaw`
            UPDATE "reviews"
               SET state = 'RESOLVED',
                   outcome = ${outcome}::"ReviewOutcome",
                   "resolvedByUserId" = ${userId}::uuid,
                   "resolvedAt" = clock_timestamp(),
                   "updatedAt" = clock_timestamp()
             WHERE id = ${reviewId}::uuid
               AND "companyId" = ${COMPANY_A.id}::uuid
          `;
        },
        { timeout: 20_000 },
      );

    const first = unsafeResolve(alice.userId, 'APPROVED', async () => {
      bothRead.arrive();
      await bothRead.ready;
    }).then(async (count) => {
      aliceWrote.arrive();

      return count;
    });

    const second = unsafeResolve(bob.userId, 'REJECTED', async () => {
      bothRead.arrive();
      await bothRead.ready;
      // Alice commits first; Bob's UPDATE then proceeds with no predicate to
      // stop it.
      await aliceWrote.ready;
    });

    const [firstCount, secondCount] = await Promise.all([first, second]);

    // BOTH updates affected a row. Neither was refused.
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });

    // THE LOST UPDATE. Alice resolved it as APPROVED and was told nothing;
    // the stored record now says Bob rejected it. Two successful state
    // transitions, and the audit trail names the wrong manager.
    expect(review.outcome).toBe('REJECTED');
    expect(review.resolvedByUserId).toBe(bob.userId);
    expect(review.resolvedByUserId).not.toBe(alice.userId);

    // And nothing raised an error anywhere - which is what makes this class
    // of bug survive in production.
  }, 60_000);

  it('F05-NC2: the real service, under the same race, lets exactly one win', async () => {
    // The same two managers, the same review, competing - through the
    // PRODUCTION code path this time.
    const reviewId = await givenOpenReview();

    barrier.arm(2, 15_000);

    const resolve = (decision: 'APPROVE' | 'REJECT', cookie: string) =>
      request(app.getHttpServer())
        .post(`/v1/reviews/${reviewId}/resolve`)
        .set({ Cookie: cookie, origin: TEST_APP_ORIGIN, 'x-limaz-client': '1' })
        .send({ decision });

    const [a, b] = await Promise.all([
      resolve('APPROVE', alice.cookie),
      resolve('REJECT', bob.cookie),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    const winner = [a, b].find((r) => r.status === 200)!;

    // One transition, and the loser changed nothing.
    expect(review.resolvedByUserId).toBe(winner.body.resolution.resolvedBy.id);
    expect(review.outcome).toBe(winner.body.resolution.outcome);

    // The pair is the evidence: the same race, the same two managers, and the
    // only difference is whether `state = 'OPEN'` is inside the UPDATE.
  }, 60_000);
});

/** A one-shot rendezvous. Resolves once every expected participant arrives. */
function gate(size = 2): { arrive: () => void; ready: Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    arrive: () => {
      arrived += 1;

      if (arrived >= size) {
        release();
      }
    },
    ready,
  };
}
