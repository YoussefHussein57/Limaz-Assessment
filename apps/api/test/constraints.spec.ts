import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { PG, createTestPrisma, expectPgError, resetDatabase } from './test-db';

/**
 * F01-T04 to F01-T12 and F01-T17 - the guarantees the schema is supposed to
 * enforce, proved by trying to break them against a real PostgreSQL.
 *
 * Every assertion here is about what the DATABASE refuses, not about what the
 * application declines to do. Application validation produces a friendly
 * error; a constraint makes the state unreachable from any writer, including
 * a migration or someone typing into psql.
 */
describe('F01 database constraints', () => {
  let prisma: PrismaClient;

  const companyA = randomUUID();
  const companyB = randomUUID();
  const managerA = randomUUID();

  beforeAll(async () => {
    prisma = createTestPrisma();
    await resetDatabase(prisma);

    await prisma.company.create({
      data: { id: companyA, name: 'Company A', currency: 'SAR' },
    });
    await prisma.company.create({
      data: { id: companyB, name: 'Company B', currency: 'SAR' },
    });
    await prisma.user.create({
      data: {
        id: managerA,
        companyId: companyA,
        email: 'a@test.invalid',
        displayName: 'Manager A',
        role: 'MANAGER',
        passwordHash: 'not-a-real-hash',
      },
    });
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  function expenseData(overrides: Record<string, unknown> = {}) {
    return {
      companyId: companyA,
      externalId: `ext-${randomUUID()}`,
      employeeId: 'emp-1',
      amountMinor: 1000,
      currency: 'SAR',
      merchant: 'Test Merchant',
      category: 'TRANSPORT',
      spentAt: new Date('2026-11-18T09:00:00.000Z'),
      decision: 'APPROVE' as const,
      status: 'APPROVED' as const,
      payloadHash: 'deadbeef',
      policySnapshot: {},
      ...overrides,
    };
  }

  // --- F01-T04 ---------------------------------------------------------------
  it('F01-T04: the same externalId twice within one company is rejected', async () => {
    await prisma.expense.create({ data: expenseData({ externalId: 'exp-dup' }) });

    const rejection = await expectPgError(() =>
      prisma.expense.create({ data: expenseData({ externalId: 'exp-dup' }) }),
    );

    expect(rejection.code).toBe(PG.UNIQUE_VIOLATION);
    expect(rejection.constraint).toBe('expenses_companyId_source_externalId_key');
  });

  // --- F01-T05 ---------------------------------------------------------------
  it('F01-T05: the same externalId in two different companies is allowed', async () => {
    const externalId = 'exp-shared-across-tenants';

    const first = await prisma.expense.create({
      data: expenseData({ externalId, companyId: companyA }),
    });
    const second = await prisma.expense.create({
      data: expenseData({ externalId, companyId: companyB }),
    });

    expect(first.id).not.toBe(second.id);
    expect(first.externalId).toBe(second.externalId);
    expect(first.companyId).not.toBe(second.companyId);

    // Uniqueness is scoped to the tenant, which is the whole point: company A
    // choosing "exp-1001" must not stop company B from doing the same.
    const count = await prisma.expense.count({ where: { externalId } });
    expect(count).toBe(2);
  });

  // --- F01-T06 ---------------------------------------------------------------
  it('F01-T06: an expense cannot have two reviews', async () => {
    const expense = await prisma.expense.create({
      data: expenseData({ decision: 'REVIEW', status: 'PENDING_REVIEW' }),
    });

    await prisma.review.create({
      data: { expenseId: expense.id, companyId: companyA, state: 'OPEN' },
    });

    const rejection = await expectPgError(() =>
      prisma.review.create({
        data: { expenseId: expense.id, companyId: companyA, state: 'OPEN' },
      }),
    );

    expect(rejection.code).toBe(PG.UNIQUE_VIOLATION);
    expect(rejection.constraint).toBe('reviews_expenseId_key');
  });

  // --- F01-T07 ---------------------------------------------------------------
  it('F01-T07: duplicate API key hashes are rejected', async () => {
    const keyHash = `hash-${randomUUID()}`;

    await prisma.apiKey.create({
      data: { companyId: companyA, keyHash, prefix: 'lmz_dev_aaaa' },
    });

    const rejection = await expectPgError(() =>
      // A different company - the hash is globally unique, because the hash is
      // the only thing presented at authentication time.
      prisma.apiKey.create({ data: { companyId: companyB, keyHash, prefix: 'lmz_dev_bbbb' } }),
    );

    expect(rejection.code).toBe(PG.UNIQUE_VIOLATION);
  });

  it('F01-T07b: duplicate session token hashes are rejected', async () => {
    const tokenHash = `session-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3_600_000);

    await prisma.session.create({ data: { userId: managerA, tokenHash, expiresAt } });

    const rejection = await expectPgError(() =>
      prisma.session.create({ data: { userId: managerA, tokenHash, expiresAt } }),
    );

    expect(rejection.code).toBe(PG.UNIQUE_VIOLATION);
  });

  // --- F01-T08 ---------------------------------------------------------------
  it('F01-T08: an expense referencing a non-existent company is rejected', async () => {
    const rejection = await expectPgError(() =>
      prisma.expense.create({ data: expenseData({ companyId: randomUUID() }) }),
    );

    expect(rejection.code).toBe(PG.FOREIGN_KEY_VIOLATION);
  });

  it('F01-T08b: a company with expenses cannot be deleted', async () => {
    await prisma.expense.create({ data: expenseData({ companyId: companyB }) });

    const rejection = await expectPgError(() => prisma.company.delete({ where: { id: companyB } }));

    // RESTRICT, not CASCADE: financial records never disappear as a side
    // effect of deleting something else.
    expect(rejection.code).toBe(PG.FOREIGN_KEY_VIOLATION);
  });

  // --- F01-T09 - the composite foreign key -----------------------------------
  it('F01-T09: a review whose companyId differs from its expense is rejected', async () => {
    const expense = await prisma.expense.create({
      data: expenseData({ companyId: companyA, decision: 'REVIEW', status: 'PENDING_REVIEW' }),
    });

    const rejection = await expectPgError(() =>
      prisma.review.create({
        data: {
          expenseId: expense.id,
          // Company B claiming a review over company A's expense. Without the
          // composite foreign key this row would be accepted, and the tenant
          // guard in the review-resolution UPDATE would then happily approve
          // it - because that guard reads reviews.companyId (ADR-004).
          companyId: companyB,
          state: 'OPEN',
        },
      }),
    );

    expect(rejection.code).toBe(PG.FOREIGN_KEY_VIOLATION);
    // Named explicitly: this must be the composite key binding the review to
    // its expense AND its tenant, not merely some foreign key somewhere.
    expect(rejection.constraint).toBe('reviews_expenseId_companyId_fkey');
  });

  it('F01-T09b: a review cannot be moved to another tenant after creation', async () => {
    const expense = await prisma.expense.create({
      data: expenseData({ companyId: companyA, decision: 'REVIEW', status: 'PENDING_REVIEW' }),
    });
    const review = await prisma.review.create({
      data: { expenseId: expense.id, companyId: companyA, state: 'OPEN' },
    });

    const rejection = await expectPgError(() =>
      prisma.review.update({ where: { id: review.id }, data: { companyId: companyB } }),
    );

    expect(rejection.code).toBe(PG.FOREIGN_KEY_VIOLATION);
    expect(rejection.constraint).toBe('reviews_expenseId_companyId_fkey');
  });

  // --- F01-T10 ---------------------------------------------------------------
  it('F01-T10: a MANAGER without a company is rejected', async () => {
    const rejection = await expectPgError(() =>
      prisma.user.create({
        data: {
          companyId: null,
          email: `orphan-${randomUUID()}@test.invalid`,
          displayName: 'Orphan Manager',
          role: 'MANAGER',
          passwordHash: 'x',
        },
      }),
    );

    // A MANAGER with a null companyId would make every tenant filter read
    // `WHERE company_id = NULL`.
    expect(rejection.code).toBe(PG.CHECK_VIOLATION);
    expect(rejection.constraint).toBe('users_role_company_check');
  });

  it('F01-T10b: a PLATFORM_ADMIN attached to a company is rejected', async () => {
    const rejection = await expectPgError(() =>
      prisma.user.create({
        data: {
          companyId: companyA,
          email: `admin-${randomUUID()}@test.invalid`,
          displayName: 'Scoped Admin',
          role: 'PLATFORM_ADMIN',
          passwordHash: 'x',
        },
      }),
    );

    expect(rejection.code).toBe(PG.CHECK_VIOLATION);
  });

  // --- F01-T11 ---------------------------------------------------------------
  it('F01-T11: an APPROVE decision cannot carry a REJECTED status', async () => {
    const rejection = await expectPgError(() =>
      prisma.expense.create({ data: expenseData({ decision: 'APPROVE', status: 'REJECTED' }) }),
    );

    // No review is opened for an APPROVE decision, so no manager could ever
    // have rejected it. The state is unreachable, and now unstorable.
    expect(rejection.code).toBe(PG.CHECK_VIOLATION);
    expect(rejection.constraint).toBe('expenses_decision_status_check');
  });

  it('F01-T11b: a REVIEW decision may end up APPROVED or REJECTED', async () => {
    const approved = await prisma.expense.create({
      data: expenseData({ decision: 'REVIEW', status: 'APPROVED' }),
    });
    const rejected = await prisma.expense.create({
      data: expenseData({ decision: 'REVIEW', status: 'REJECTED' }),
    });

    // The decision records what the policy concluded and never changes; the
    // status records the outcome and moves once.
    expect(approved.decision).toBe('REVIEW');
    expect(approved.status).toBe('APPROVED');
    expect(rejected.decision).toBe('REVIEW');
    expect(rejected.status).toBe('REJECTED');
  });

  // --- F01-T12 ---------------------------------------------------------------
  it('F01-T12: a RESOLVED review without a recorded reviewer is rejected', async () => {
    const expense = await prisma.expense.create({
      data: expenseData({ decision: 'REVIEW', status: 'APPROVED' }),
    });

    const rejection = await expectPgError(() =>
      prisma.review.create({
        data: {
          expenseId: expense.id,
          companyId: companyA,
          state: 'RESOLVED',
          outcome: 'APPROVED',
          // resolvedByUserId and resolvedAt deliberately omitted.
        },
      }),
    );

    expect(rejection.code).toBe(PG.CHECK_VIOLATION);
    expect(rejection.constraint).toBe('reviews_state_resolution_check');
  });

  it('F01-T12b: an OPEN review carrying an outcome is rejected', async () => {
    const expense = await prisma.expense.create({
      data: expenseData({ decision: 'REVIEW', status: 'PENDING_REVIEW' }),
    });

    const rejection = await expectPgError(() =>
      prisma.review.create({
        data: {
          expenseId: expense.id,
          companyId: companyA,
          state: 'OPEN',
          outcome: 'APPROVED',
        },
      }),
    );

    expect(rejection.code).toBe(PG.CHECK_VIOLATION);
  });

  it('F01-T12c: a fully resolved review is accepted and records who, when and how', async () => {
    const expense = await prisma.expense.create({
      data: expenseData({ decision: 'REVIEW', status: 'APPROVED' }),
    });
    const resolvedAt = new Date('2026-11-18T12:00:00.000Z');

    const review = await prisma.review.create({
      data: {
        expenseId: expense.id,
        companyId: companyA,
        state: 'RESOLVED',
        outcome: 'APPROVED',
        resolvedByUserId: managerA,
        resolvedAt,
      },
    });

    expect(review.state).toBe('RESOLVED');
    expect(review.outcome).toBe('APPROVED');
    expect(review.resolvedByUserId).toBe(managerA);
    expect(review.resolvedAt).toEqual(resolvedAt);
  });

  it('F01-T12d: a user who has resolved a review cannot be deleted', async () => {
    const rejection = await expectPgError(() => prisma.user.delete({ where: { id: managerA } }));

    // Deleting the reviewer would erase the audit trail the assessment
    // requires. Deactivation, not deletion, is the right answer for a leaver.
    expect(rejection.code).toBe(PG.FOREIGN_KEY_VIOLATION);
  });

  // --- F01-T17 ---------------------------------------------------------------
  it('F01-T17: a negative amount is rejected', async () => {
    const rejection = await expectPgError(() =>
      prisma.expense.create({ data: expenseData({ amountMinor: -1 }) }),
    );

    expect(rejection.code).toBe(PG.CHECK_VIOLATION);
    expect(rejection.constraint).toBe('expenses_amount_non_negative_check');
  });

  it('F01-T17b: a rule fires at most once per expense', async () => {
    const expense = await prisma.expense.create({
      data: expenseData({ decision: 'REJECT', status: 'REJECTED' }),
    });

    await prisma.ruleHit.create({
      data: {
        expenseId: expense.id,
        ruleCode: 'BLOCKED_CATEGORY',
        decision: 'REJECT',
        detail: {},
      },
    });

    const rejection = await expectPgError(() =>
      prisma.ruleHit.create({
        data: {
          expenseId: expense.id,
          ruleCode: 'BLOCKED_CATEGORY',
          decision: 'REJECT',
          detail: {},
        },
      }),
    );

    expect(rejection.code).toBe(PG.UNIQUE_VIOLATION);
  });

  it('F01-T17c: nonsensical policy settings are rejected', async () => {
    const rejection = await expectPgError(() =>
      prisma.policy.create({
        data: {
          companyId: companyB,
          autoApproveLimitMinor: 1000,
          frequencyMaxCount: 0, // "more than zero expenses" would fire always
          frequencyWindowMinutes: 60,
          blockedCategories: [],
        },
      }),
    );

    expect(rejection.code).toBe(PG.CHECK_VIOLATION);
  });
});
