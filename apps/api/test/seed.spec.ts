import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  API_KEYS,
  COMPANY_A,
  COMPANY_B,
  EXPECTED,
  USERS,
} from '../prisma/seed/fixtures';
import { seed } from '../prisma/seed/run';
import { createTestPrisma, resetDatabase } from './test-db';

/**
 * F01-T13 to F01-T16 - the seed produces the data the assessment asks for,
 * and running it again changes nothing.
 *
 * The seed is run by the container entrypoint on every start, so a seed that
 * is not idempotent would double the data on the second `docker compose up`.
 */
describe('F01 seed', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await resetDatabase(prisma);
    await seed(prisma);
  }, 60_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  // --- F01-T13 ---------------------------------------------------------------
  it('F01-T13: creates exactly two companies, with different policies', async () => {
    const companies = await prisma.company.findMany({
      include: { policy: true },
      orderBy: { name: 'asc' },
    });

    expect(companies).toHaveLength(2);

    const [delta, nile] = companies;
    expect(nile!.name).toBe(COMPANY_A.name);
    expect(delta!.name).toBe(COMPANY_B.name);

    // The assessment requires the two seeded companies to differ. Asserting
    // "they are not equal" would pass if both were wrong, so each field is
    // checked against the fixture AND against the other company.
    expect(nile!.policy!.autoApproveLimitMinor).toBe(COMPANY_A.policy.autoApproveLimitMinor);
    expect(delta!.policy!.autoApproveLimitMinor).toBe(COMPANY_B.policy.autoApproveLimitMinor);
    expect(nile!.policy!.autoApproveLimitMinor).not.toBe(delta!.policy!.autoApproveLimitMinor);

    expect(nile!.policy!.frequencyMaxCount).not.toBe(delta!.policy!.frequencyMaxCount);
    expect(nile!.policy!.frequencyWindowMinutes).not.toBe(delta!.policy!.frequencyWindowMinutes);
    expect(nile!.policy!.blockedCategories).not.toEqual(delta!.policy!.blockedCategories);
  });

  // --- F01-T14 ---------------------------------------------------------------
  it('F01-T14: creates one manager per company and one platform admin', async () => {
    const users = await prisma.user.findMany({ orderBy: { email: 'asc' } });
    expect(users).toHaveLength(EXPECTED.users);

    const admins = users.filter((u) => u.role === 'PLATFORM_ADMIN');
    const managers = users.filter((u) => u.role === 'MANAGER');

    expect(admins).toHaveLength(1);
    expect(admins[0]!.companyId).toBeNull();

    expect(managers).toHaveLength(2);
    expect(managers.map((m) => m.companyId).sort()).toEqual([COMPANY_A.id, COMPANY_B.id].sort());
  });

  it('F01-T14b: passwords are stored as bcrypt hashes, never in plain text', async () => {
    const users = await prisma.user.findMany();

    for (const user of users) {
      const fixture = USERS.find((u) => u.id === user.id)!;
      expect(user.passwordHash).not.toBe(fixture.password);
      expect(user.passwordHash).not.toContain(fixture.password);
      // bcrypt modular crypt format: $2a$ / $2b$ / $2y$ followed by the cost.
      expect(user.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    }
  });

  it('F01-T14c: API keys are stored as hashes, never in plain text', async () => {
    const keys = await prisma.apiKey.findMany();
    expect(keys).toHaveLength(EXPECTED.apiKeys);

    for (const key of keys) {
      const fixture = API_KEYS.find((k) => k.id === key.id)!;
      expect(key.keyHash).not.toBe(fixture.plaintext);
      expect(key.keyHash).toBe(createHash('sha256').update(fixture.plaintext).digest('hex'));
      // The prefix is for display only and is a strict prefix of the key.
      expect(fixture.plaintext.startsWith(key.prefix)).toBe(true);
      expect(key.prefix.length).toBeLessThan(fixture.plaintext.length);
      expect(key.status).toBe('ACTIVE');
    }
  });

  // --- F01-T15 ---------------------------------------------------------------
  it('F01-T15: running the seed twice does not duplicate anything', async () => {
    const before = await countEverything(prisma);

    await seed(prisma);

    const after = await countEverything(prisma);
    expect(after).toEqual(before);
    expect(after).toEqual(EXPECTED);
  }, 60_000);

  it('F01-T15b: re-running the seed preserves the fixed row identities', async () => {
    const idsBefore = (await prisma.expense.findMany({ select: { id: true } })).map((e) => e.id);

    await seed(prisma);

    const idsAfter = (await prisma.expense.findMany({ select: { id: true } })).map((e) => e.id);
    expect(idsAfter.sort()).toEqual(idsBefore.sort());
  }, 60_000);

  // --- F01-T16 ---------------------------------------------------------------
  it('F01-T16: every REVIEW decision has a review, and no other decision does', async () => {
    const expenses = await prisma.expense.findMany({ include: { review: true } });

    for (const expense of expenses) {
      if (expense.decision === 'REVIEW') {
        expect(expense.review).not.toBeNull();
      } else {
        expect(expense.review).toBeNull();
      }
    }
  });

  it('F01-T16b: resolved reviews match their expense status, open ones are pending', async () => {
    const reviews = await prisma.review.findMany({ include: { expense: true } });
    expect(reviews).toHaveLength(EXPECTED.reviews);

    for (const review of reviews) {
      // The composite foreign key guarantees this, so a failure here would
      // mean the constraint is missing rather than the data being wrong.
      expect(review.companyId).toBe(review.expense.companyId);

      if (review.state === 'OPEN') {
        expect(review.expense.status).toBe('PENDING_REVIEW');
        expect(review.outcome).toBeNull();
        expect(review.resolvedByUserId).toBeNull();
      } else {
        expect(review.expense.status).toBe(review.outcome);
        expect(review.resolvedByUserId).not.toBeNull();
        expect(review.resolvedAt).not.toBeNull();
      }
    }
  });

  it('F01-T16c: the dashboard has both open and resolved work to show', async () => {
    const open = await prisma.review.count({ where: { state: 'OPEN' } });
    const resolved = await prisma.review.count({ where: { state: 'RESOLVED' } });

    expect(open).toBeGreaterThan(0);
    expect(resolved).toBeGreaterThan(0);

    // And both resolution outcomes are represented.
    const outcomes = await prisma.review.findMany({
      where: { state: 'RESOLVED' },
      select: { outcome: true },
    });
    expect(new Set(outcomes.map((o) => o.outcome))).toEqual(new Set(['APPROVED', 'REJECTED']));
  });

  it('F01-T16d: all three decisions are represented, including a multi-rule rejection', async () => {
    const decisions = await prisma.expense.groupBy({ by: ['decision'], _count: true });
    const byDecision = new Map(decisions.map((d) => [d.decision, d._count]));

    expect(byDecision.get('APPROVE')).toBeGreaterThan(0);
    expect(byDecision.get('REVIEW')).toBeGreaterThan(0);
    expect(byDecision.get('REJECT')).toBeGreaterThan(0);

    // At least one expense where two rules fired and REJECT won over REVIEW,
    // so the "every reason is reported" behaviour has something to show.
    const multiRule = await prisma.expense.findMany({
      where: { ruleHits: { some: { decision: 'REVIEW' } }, decision: 'REJECT' },
      include: { ruleHits: true },
    });
    expect(multiRule.length).toBeGreaterThan(0);
    expect(multiRule[0]!.ruleHits.length).toBeGreaterThanOrEqual(2);
  });

  it('F01-T16e: the seed itself demonstrates tenant-scoped externalId uniqueness', async () => {
    const shared = await prisma.expense.findMany({ where: { externalId: 'exp-1001' } });

    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((e) => e.companyId))).toEqual(new Set([COMPANY_A.id, COMPANY_B.id]));
  });

  it('F01-T16f: every expense carries the policy snapshot it was judged against', async () => {
    const expenses = await prisma.expense.findMany();

    for (const expense of expenses) {
      const snapshot = expense.policySnapshot as Record<string, unknown>;
      expect(snapshot).toBeTruthy();
      expect(typeof snapshot.autoApproveLimitMinor).toBe('number');
      expect(typeof snapshot.frequencyMaxCount).toBe('number');
      expect(Array.isArray(snapshot.blockedCategories)).toBe(true);
    }

    // The two companies' snapshots differ, so the snapshot is genuinely per
    // company rather than a constant written once.
    const a = await prisma.expense.findFirst({ where: { companyId: COMPANY_A.id } });
    const b = await prisma.expense.findFirst({ where: { companyId: COMPANY_B.id } });
    expect((a!.policySnapshot as Record<string, unknown>).autoApproveLimitMinor).not.toBe(
      (b!.policySnapshot as Record<string, unknown>).autoApproveLimitMinor,
    );
  });
});

async function countEverything(prisma: PrismaClient) {
  return {
    companies: await prisma.company.count(),
    policies: await prisma.policy.count(),
    users: await prisma.user.count(),
    apiKeys: await prisma.apiKey.count(),
    expenses: await prisma.expense.count(),
    ruleHits: await prisma.ruleHit.count(),
    reviews: await prisma.review.count(),
    openReviews: await prisma.review.count({ where: { state: 'OPEN' } }),
  };
}
