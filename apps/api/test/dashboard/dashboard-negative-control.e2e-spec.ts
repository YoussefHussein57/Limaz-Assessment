import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { COMPANY_A, COMPANY_B, EXPENSES } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { DashboardSummaryService } from '../../src/dashboard/dashboard-summary.service';
import { testDatabaseUrl } from '../database-url';
import { resetDatabase } from '../test-db';

/**
 * F06-NC1 - the control for F06-T05.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * F06-T05 asserts that one company's dashboard excludes the other's expenses.
 * On its own that assertion proves less than it looks: it would ALSO pass if
 * the two companies happened to have counts that lined up, and it says nothing
 * about whether the tenant predicate is what produced the right answer.
 *
 * So the predicate is removed and the same question asked again. If the
 * aggregate still looks right without it, the test was never testing it.
 *
 * Nothing in the application is modified. The broken query is written out HERE,
 * in the test, exactly as somebody would write it by mistake - a `groupBy` with
 * no `where`. There is no flag, no environment variable and no code path in
 * `DashboardSummaryService` that can produce this; a running application cannot
 * reach it.
 *
 * It runs against the throwaway TEST database, never the development one.
 */
describe('F06-NC1 dashboard tenant scoping negative control', () => {
  let prisma: PrismaClient;
  let service: DashboardSummaryService;

  const nileCount = EXPENSES.filter((e) => e.companyId === COMPANY_A.id).length;
  const deltaCount = EXPENSES.filter((e) => e.companyId === COMPANY_B.id).length;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrl(), max: 5 }),
    });

    await prisma.$connect();
    await resetDatabase(prisma);
    await seed(prisma);

    service = new DashboardSummaryService(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  it('the two companies have DIFFERENT expense counts, so the control can distinguish them', async () => {
    // Stated first and asserted, because the whole control depends on it. If
    // the seed ever gave both companies the same number of expenses, every
    // assertion below would pass under a missing tenant predicate and this
    // file would prove nothing while still being green.
    expect(nileCount).not.toBe(deltaCount);
    expect(nileCount).toBeGreaterThan(0);
    expect(deltaCount).toBeGreaterThan(0);
  });

  it('WITH the tenant predicate: each company sees only its own expenses', async () => {
    const nile = await service.summarise(COMPANY_A.id);
    const delta = await service.summarise(COMPANY_B.id);

    expect(nile.total).toBe(nileCount);
    expect(delta.total).toBe(deltaCount);
    expect(nile.total + delta.total).toBe(nileCount + deltaCount);
  });

  it('WITHOUT it: every company sees every expense, and nothing errors', async () => {
    // The mistake, written out: the same aggregate with no `where`.
    const groups = await prisma.expense.groupBy({
      by: ['status', 'decision', 'currency'],
      _count: { _all: true },
      _sum: { amountMinor: true },
    });

    const leaked = groups.reduce((sum, group) => sum + group._count._all, 0);

    // It is the whole table, not one company's share.
    expect(leaked).toBe(nileCount + deltaCount);
    expect(leaked).toBeGreaterThan(nileCount);
    expect(leaked).toBeGreaterThan(deltaCount);

    // And this is the part that matters: NO ERROR IS RAISED ANYWHERE. The
    // query succeeds, the dashboard renders, the numbers are simply another
    // company's. Nothing in the stack would have told anyone.

    // Finally, prove F06-T05's own assertion would have failed:
    const nile = await service.summarise(COMPANY_A.id);
    expect(nile.total).not.toBe(leaked);
  });
});
