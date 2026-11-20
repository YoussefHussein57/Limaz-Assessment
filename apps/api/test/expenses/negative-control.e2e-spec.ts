import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { EXPENSE_IDEMPOTENCY_CONSTRAINT } from '../../src/expenses/idempotency-conflict';
import { TEST_DATABASE_NAME } from '../database-url';
import { resetDatabase } from '../test-db';
import { createExpensesTestApp } from './expenses-test-app';
import { TestPolicyEvaluator } from './test-policy-evaluator';

/**
 * F03-T27, T28 - negative controls.
 *
 * A test that passes with and without the mechanism it claims to verify is
 * not a test. These remove the protection and show the system breaking in the
 * predicted way, which is the only evidence that the protection was doing the
 * work.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 * ---------------------------------------------------------------------------
 *
 * These DROP a constraint. Doing that to the development database would
 * corrupt data a reviewer is looking at, so:
 *
 *   - it runs only against `limaz_test`, which is dropped and recreated on
 *     every run, and the database name is ASSERTED here rather than assumed;
 *   - the constraint is restored in `afterAll`, and the restore is asserted,
 *     so a later suite cannot inherit a weakened schema;
 *   - there is NO environment flag that disables the constraint. Shipping a
 *     switch that turns off a correctness guarantee is a worse outcome than
 *     the problem it solves - someone would eventually set it.
 */
describe('F03 negative controls', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let evaluator: TestPolicyEvaluator;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    externalId: 'exp-negative',
    employeeId: 'emp-neg',
    amount: 12_500,
    currency: 'SAR',
    merchant: 'City Taxi',
    category: 'TRANSPORT',
    spentAt: '2026-11-20T09:15:00.000Z',
    ...overrides,
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/v1/expenses').set('x-api-key', nileKey).send(body);

  beforeAll(async () => {
    evaluator = new TestPolicyEvaluator();

    const booted = await createExpensesTestApp(evaluator);
    app = booted.app;
    prisma = booted.prisma;

    // The guard. `current_database()` is read from the live connection, not
    // from a string we built, so it cannot be fooled by a malformed URL.
    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    const name = rows[0]?.name;

    if (name !== TEST_DATABASE_NAME) {
      throw new Error(
        `REFUSING TO RUN: this suite drops a database constraint and is connected to ` +
          `"${name}", not "${TEST_DATABASE_NAME}".`,
      );
    }

    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await restoreConstraint(prisma);
    await resetDatabase(prisma);
    await app?.close();
  });

  beforeEach(() => {
    // Call records accumulate across tests otherwise, so an assertion about
    // "how many evaluations did THIS race cause" would silently be counting
    // the previous test's as well.
    evaluator.calls.length = 0;
    evaluator.withoutBarrier().failingWith(null);
  });

  it('F03-T27: without the unique constraint, the concurrent race creates two rows', async () => {
    const externalId = 'exp-negative-race';

    // Baseline: WITH the constraint, this race produces exactly one row.
    evaluator.withBarrier(2, 5_000);

    const guarded = await Promise.all([
      post(valid({ externalId, employeeId: 'emp-alpha' })),
      post(valid({ externalId, employeeId: 'emp-beta' })),
    ]);

    expect(guarded.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.expense.count({ where: { externalId } })).toBe(1);

    // Now remove it and run the identical race.
    await prisma.$executeRawUnsafe(`DROP INDEX "${EXPENSE_IDEMPOTENCY_CONSTRAINT}"`);

    const unguardedId = 'exp-negative-race-2';
    evaluator.withBarrier(2, 5_000);

    const unguarded = await Promise.all([
      post(valid({ externalId: unguardedId, employeeId: 'emp-alpha' })),
      post(valid({ externalId: unguardedId, employeeId: 'emp-beta' })),
    ]);

    // BOTH succeed. Two rows now share (companyId, externalId), which is the
    // duplicate expense the whole feature exists to prevent.
    expect(unguarded.map((r) => r.status)).toEqual([201, 201]);

    const duplicated = await prisma.expense.findMany({ where: { externalId: unguardedId } });
    expect(duplicated).toHaveLength(2);
    expect(duplicated[0]!.companyId).toBe(duplicated[1]!.companyId);

    // ---------------------------------------------------------------------
    // What this proves, and it is more than "the constraint works":
    //
    // In the guarded run the two transactions were held at the barrier, so
    // neither could have seen the other's committed row at the idempotency
    // read. The 409 therefore came from the INSERT raising 23505 and the
    // service resolving the outcome after the aborted transaction rolled
    // back - the path that returns 500 if anyone tries to query inside it.
    //
    // Remove the constraint and that path disappears along with the 409.
    // ---------------------------------------------------------------------

    // The damage is not merely visible - it is LOAD-BEARING. PostgreSQL will
    // not build a unique index over rows that violate it, so the guarantee
    // cannot be restored until the duplicate is removed. In a real system
    // that is the difference between an incident and a migration that cannot
    // run at all.
    await expect(
      prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "${EXPENSE_IDEMPOTENCY_CONSTRAINT}" ` +
          `ON "expenses" ("companyId", "externalId")`,
      ),
    ).rejects.toThrow(/could not create unique index/u);

    await restoreConstraint(prisma);

    // And with it back, the race is safe again.
    const restoredId = 'exp-negative-race-3';
    evaluator.withBarrier(2, 5_000);

    const reguarded = await Promise.all([
      post(valid({ externalId: restoredId, employeeId: 'emp-alpha' })),
      post(valid({ externalId: restoredId, employeeId: 'emp-beta' })),
    ]);

    expect(reguarded.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.expense.count({ where: { externalId: restoredId } })).toBe(1);
  }, 30_000);

  it('F03-T28: idempotency does not depend on the advisory lock', async () => {
    // The lock is taken in F03 for F04's frequency count, not for idempotency.
    // This asserts the separation directly: two requests that take DIFFERENT
    // lock keys - so the lock serialises nothing between them - still cannot
    // produce two rows, because the constraint is what guarantees that.
    //
    // It is the same shape as F03-T21, stated here as a claim about WHICH
    // mechanism is responsible rather than about the outcome.
    const externalId = 'exp-no-lock-help';

    evaluator.withBarrier(2, 5_000);

    const responses = await Promise.all([
      post(valid({ externalId, employeeId: 'emp-one' })),
      post(valid({ externalId, employeeId: 'emp-two' })),
    ]);

    // Both were inside their transactions simultaneously: the barrier could
    // not have released otherwise.
    expect(evaluator.calls).toHaveLength(2);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.expense.count({ where: { externalId } })).toBe(1);
  }, 30_000);

  it('F03-T29: the barrier fails loudly rather than hanging', async () => {
    // The guard on the guard. A barrier sized for participants that never
    // arrive - here, two requests that SHARE a lock key and therefore
    // serialise - must fail in seconds with a readable message instead of
    // stalling the suite while holding open transactions.
    evaluator.withBarrier(2, 1_000);

    const response = await post(
      valid({ externalId: 'exp-barrier-timeout', employeeId: 'emp-solo' }),
    );

    expect(response.status).toBe(500);

    // The timeout surfaced as a controlled failure, and nothing was written.
    expect(await prisma.expense.count({ where: { externalId: 'exp-barrier-timeout' } })).toBe(0);

    evaluator.withoutBarrier();
  }, 15_000);
});

/**
 * Puts the unique index back, and proves it is back.
 *
 * IT IS AN INDEX, NOT A TABLE CONSTRAINT.
 *
 * Prisma's `@@unique` emits `CREATE UNIQUE INDEX`, not `ALTER TABLE ... ADD
 * CONSTRAINT`, so `expenses_companyId_externalId_key` appears in `pg_indexes`
 * and is absent from `pg_constraint` entirely. The uniqueness guarantee and
 * the 23505 it raises are identical either way - but the DDL to remove it,
 * and the catalogue to verify it in, are not. The first version of this test
 * said DROP CONSTRAINT and failed with `42704 does not exist`, which is how
 * the difference surfaced.
 *
 * `IF NOT EXISTS` is supported for CREATE INDEX, so no catch is needed; the
 * assertion afterwards is what actually guarantees the schema was restored
 * for whatever runs next.
 */
async function restoreConstraint(prisma: PrismaClient): Promise<void> {
  // The duplicates have to go first, and the reason is the clearest evidence
  // this negative control produces: PostgreSQL REFUSES to build a unique index
  // over rows that violate it -
  //
  //   23505  could not create unique index "expenses_companyId_externalId_key"
  //
  // so the damage done while the index was absent is not merely detectable
  // afterwards, it physically blocks the guarantee from being restored. In a
  // real system that is the difference between an outage and a migration that
  // cannot run.
  //
  // Reviews are deleted first: Review -> Expense is onDelete: Restrict, so an
  // expense with a review cannot be removed. Rule hits cascade.
  await prisma.$executeRawUnsafe(`
    WITH duplicates AS (
      SELECT ctid FROM (
        SELECT ctid, row_number() OVER (
          PARTITION BY "companyId", "externalId" ORDER BY "createdAt", ctid
        ) AS rn
        FROM "expenses"
      ) ranked WHERE rn > 1
    )
    DELETE FROM "reviews" WHERE "expenseId" IN (
      SELECT id FROM "expenses" WHERE ctid IN (SELECT ctid FROM duplicates)
    )
  `);

  await prisma.$executeRawUnsafe(`
    DELETE FROM "expenses" WHERE ctid IN (
      SELECT ctid FROM (
        SELECT ctid, row_number() OVER (
          PARTITION BY "companyId", "externalId" ORDER BY "createdAt", ctid
        ) AS rn
        FROM "expenses"
      ) ranked WHERE rn > 1
    )
  `);

  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${EXPENSE_IDEMPOTENCY_CONSTRAINT}" ` +
      `ON "expenses" ("companyId", "externalId")`,
  );

  const rows = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'expenses' AND indexname = ${EXPENSE_IDEMPOTENCY_CONSTRAINT}
  `;

  if (rows.length !== 1) {
    throw new Error(
      `The idempotency index was not restored. The test database schema is now weaker ` +
        `than production and every suite after this one is unreliable.`,
    );
  }
}
