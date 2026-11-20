import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import {
  createPolicyTestApp,
  type CountThenPauseEvaluator,
  type RequestBarrierInterceptor,
} from './policy-test-app';

/**
 * F04-NC1 - the frequency negative control.
 *
 * A concurrency test that passes with and without the mechanism it claims to
 * verify is not evidence. This removes the advisory lock and shows the
 * frequency rule silently failing - which is the only way to know that
 * F04-T26's "3 APPROVE, 2 REVIEW" was produced by serialisation rather than
 * by luck.
 *
 * ---------------------------------------------------------------------------
 * WHY A PRE-LOCK BARRIER IS NOT ENOUGH ON ITS OWN
 * ---------------------------------------------------------------------------
 *
 * Releasing five requests together proves they were all in flight. It does
 * NOT prove they all read the same count: with no serialisation, one
 * transaction can still count, insert and commit before another reaches its
 * count, and the result would be a mixture that happens to look correct. The
 * control would then pass intermittently and prove nothing.
 *
 * So there is a SECOND synchronisation point, after the frequency count and
 * before any row is written. Every competitor must reach it before any of
 * them continues, which makes "all five counted zero" a determined outcome
 * rather than a likely one.
 *
 * That second barrier is used ONLY here, and ONLY with the lock replaced by a
 * no-op. Competitors sharing an advisory lock key cannot all reach a point
 * inside the lock, so pairing it with the real lock would deadlock until the
 * timeout - the failure mode this file exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 * ---------------------------------------------------------------------------
 *
 * The substitution happens through Nest's testing `overrideProvider`. There
 * is NO environment variable and NO configuration flag that can disable the
 * lock in a running application - a flag would eventually be set by someone
 * debugging something else, and turning off a correctness guarantee is worse
 * than the problem it solves.
 *
 * Nothing here is destructive: no DDL, no dropped constraint. It runs against
 * `limaz_test` like every other suite.
 */
describe('F04 frequency negative control', () => {
  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const SPENT_AT = '2026-11-20T12:00:00.000Z';

  const submitTo = (
    app: INestApplication,
    externalId: string,
    employeeId = 'emp-nc',
  ): request.Test =>
    request(app.getHttpServer()).post('/v1/expenses').set('x-api-key', nileKey).send({
      externalId,
      employeeId,
      amount: 1_000,
      currency: 'SAR',
      merchant: 'City Taxi',
      category: 'TRANSPORT',
      spentAt: SPENT_AT,
    });

  const clear = async (prisma: PrismaClient): Promise<void> => {
    await prisma.ruleHit.deleteMany({
      where: { expense: { employeeId: { startsWith: 'emp-nc' } } },
    });
    await prisma.review.deleteMany({
      where: { expense: { employeeId: { startsWith: 'emp-nc' } } },
    });
    await prisma.expense.deleteMany({ where: { employeeId: { startsWith: 'emp-nc' } } });
  };

  it('F04-NC1: without the advisory lock, five concurrent expenses all read zero and all approve', async () => {
    // ---- 1. The guarded baseline -----------------------------------------
    const guarded = await createPolicyTestApp();
    await resetDatabase(guarded.prisma);
    await seed(guarded.prisma);
    await clear(guarded.prisma);

    guarded.barrier.arm(5, 15_000);

    const withLock = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => submitTo(guarded.app, `nc-locked-${i}`)),
    );

    expect(withLock.every((r) => r.status === 201)).toBe(true);
    expect(withLock.map((r) => r.body.decision as string).sort()).toEqual([
      'APPROVE',
      'APPROVE',
      'APPROVE',
      'REVIEW',
      'REVIEW',
    ]);

    const guardedReviews = await guarded.prisma.review.count({
      where: { expense: { employeeId: 'emp-nc' } },
    });
    expect(guardedReviews).toBe(2);

    await clear(guarded.prisma);
    await guarded.app.close();

    // ---- 2. The same code path, with the lock removed --------------------
    const unlocked = await createPolicyTestApp({ unlocked: true, pauseAfterCount: true });
    const pausing = unlocked.pausing as CountThenPauseEvaluator;
    const barrier = unlocked.barrier as RequestBarrierInterceptor;

    await clear(unlocked.prisma);

    // Both synchronisation points: in flight together, and held between the
    // count and the write.
    barrier.arm(5, 15_000);
    pausing.arm(5, 15_000);

    const withoutLock = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => submitTo(unlocked.app, `nc-unlocked-${i}`)),
    );

    expect(withoutLock.every((r) => r.status === 201)).toBe(true);

    // THE FAILURE. Every transaction counted zero existing expenses, so every
    // one of them concluded it was the first in the window.
    const decisions = withoutLock.map((r) => r.body.decision as string);
    expect(decisions).toEqual(['APPROVE', 'APPROVE', 'APPROVE', 'APPROVE', 'APPROVE']);

    const stored = await unlocked.prisma.expense.findMany({
      where: { employeeId: 'emp-nc' },
    });

    // Five expenses for one employee inside one 60-minute window, with a
    // policy that allows three, and NOT ONE of them was reviewed. No error
    // was raised anywhere: the rule simply stopped working.
    expect(stored).toHaveLength(5);
    expect(stored.filter((e) => e.decision === 'REVIEW')).toHaveLength(0);

    const reviews = await unlocked.prisma.review.count({
      where: { expense: { employeeId: 'emp-nc' } },
    });
    expect(reviews).toBe(0);

    const hits = await unlocked.prisma.ruleHit.count({
      where: { expense: { employeeId: 'emp-nc' }, ruleCode: 'FREQUENCY' },
    });
    expect(hits).toBe(0);

    // The unique index is untouched here, so idempotency still holds - which
    // is the point ADR-007 makes: these are two different guarantees needing
    // two different mechanisms. Removing the lock breaks the frequency rule
    // and leaves idempotency intact.
    const ids = new Set(stored.map((e) => e.externalId));
    expect(ids.size).toBe(5);

    await clear(unlocked.prisma);
    await unlocked.app.close();
  }, 90_000);

  it('F04-NC2: the pause-after-count mechanism is only safe without the lock', async () => {
    // The guard on the guard, and the reason it is written down: pairing the
    // post-count barrier with the REAL lock deadlocks, because competitors
    // sharing a lock key cannot all be inside it. Here that is demonstrated
    // with a short timeout so it fails fast and visibly instead of being a
    // trap for whoever writes the next concurrency test.
    const app = await createPolicyTestApp({ pauseAfterCount: true });
    const pausing = app.pausing as CountThenPauseEvaluator;

    await clear(app.prisma);

    app.barrier.arm(2, 10_000);
    pausing.arm(2, 1_500);

    const responses = await Promise.all([
      submitTo(app.app, 'nc-deadlock-1'),
      submitTo(app.app, 'nc-deadlock-2'),
    ]);

    // One holds the lock and waits at the barrier for a partner that cannot
    // get past the lock to join it. The barrier times out rather than
    // hanging, which is exactly why every barrier in this repository is
    // bounded.
    expect(responses.some((r) => r.status === 500)).toBe(true);

    await clear(app.prisma);
    await app.app.close();
  }, 60_000);
});
