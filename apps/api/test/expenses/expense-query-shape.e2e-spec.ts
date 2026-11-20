import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { COMPANY_A } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { DashboardSummaryService } from '../../src/dashboard/dashboard-summary.service';
import { ExpenseQueryService } from '../../src/expenses/expense-query.service';
import { testDatabaseUrl } from '../database-url';
import { resetDatabase } from '../test-db';

/**
 * F06-T20 - what the expense listing actually costs.
 *
 * Two separate questions, measured rather than asserted:
 *
 *   1. Does the statement count grow with the number of rows? That is the
 *      definition of N+1, and `include` does NOT always compile to one joined
 *      query - Prisma may issue one statement per relation LEVEL and stitch
 *      the results in memory. That is fine. One statement per ROW is not.
 *
 *   2. Does PostgreSQL use the composite index? `@@index([companyId, spentAt])`
 *      exists for this query, but an index EXISTING is not an index being
 *      CHOSEN - the planner decides, and on a small table it will rightly
 *      prefer a sequential scan. So the table is grown to a size where the
 *      choice is meaningful and EXPLAIN ANALYZE is read.
 *
 * A dedicated client is built here with query logging on, because the
 * application's PrismaService is shared and turning logging on globally would
 * affect every other suite.
 */
describe('F06 expense query shape', () => {
  let prisma: PrismaClient;
  let expenses: ExpenseQueryService;
  let dashboard: DashboardSummaryService;
  // Initialised HERE, not in beforeEach: the query listener is attached in
  // beforeAll, which runs first, and would otherwise push into undefined.
  let statements: string[] = [];

  const ROWS = 4_000;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrl(), max: 5 }),
      log: [{ emit: 'event', level: 'query' }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$on('query', (event: { query: string }) => {
      statements.push(event.query);
    });

    await prisma.$connect();
    await resetDatabase(prisma);
    await seed(prisma);

    // Enough rows that a sequential scan is a real cost and an N+1 would be
    // unmistakable. Spread over distinct `spentAt` values so the ordering has
    // something to do.
    const base = Date.now() - 400 * 24 * 3_600_000;

    for (let batch = 0; batch < ROWS / 500; batch += 1) {
      await prisma.expense.createMany({
        data: Array.from({ length: 500 }, (_, i) => {
          const n = batch * 500 + i;

          return {
            companyId: COMPANY_A.id,
            externalId: `shape-${n}`,
            employeeId: `emp-shape-${n % 50}`,
            amountMinor: 1_000 + n,
            currency: 'SAR',
            merchant: `Shop ${n % 97}`,
            category: 'TRANSPORT',
            spentAt: new Date(base + n * 60_000),
            decision: 'APPROVE' as const,
            status: 'APPROVED' as const,
            payloadHash: `shape-${n}`.padEnd(64, '0'),
            policySnapshot: {},
          };
        }),
      });
    }

    await prisma.$executeRawUnsafe('ANALYZE "expenses"');

    expenses = new ExpenseQueryService(prisma as never);
    dashboard = new DashboardSummaryService(prisma as never);
  }, 180_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    statements = [];
  });

  const query = (overrides: Partial<Parameters<ExpenseQueryService['list']>[1]> = {}) => ({
    status: 'ALL' as const,
    decision: 'ALL' as const,
    limit: 25,
    ...overrides,
  });

  it('F06-T20: the statement count does not grow with the number of rows', async () => {
    statements = [];
    const small = await expenses.list(COMPANY_A.id, query({ limit: 5 }));
    const forFive = statements.filter(isSelect).length;

    statements = [];
    const large = await expenses.list(COMPANY_A.id, query({ limit: 50 }));
    const forFifty = statements.filter(isSelect).length;

    expect(small.items).toHaveLength(5);
    expect(large.items).toHaveLength(50);

    // THE ASSERTION THAT MATTERS. Ten times the rows, the same number of
    // statements. An N+1 would make the second number roughly ten times the
    // first.
    expect(forFifty).toBe(forFive);

    // And it is a small, bounded number - one per relation level at most.
    expect(forFive).toBeLessThanOrEqual(4);

    console.log(`\n--- listing: ${forFive} statements for 5 rows, ${forFifty} for 50 rows ---\n`);
  }, 60_000);

  it('F06-T20b: the dashboard summary is exactly one statement', async () => {
    statements = [];
    await dashboard.summarise(COMPANY_A.id);

    const selects = statements.filter(isSelect);

    // Not "few". ONE - which is what makes the figures a single MVCC
    // snapshot and therefore mutually consistent. Four count() calls would
    // show four here and the status counts could disagree with the total.
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatch(/GROUP BY/iu);

    console.log(`\n--- dashboard summary: ${selects.length} statement ---\n`);
  }, 60_000);

  it('F06-T20c: the planner chooses an index scan at this table size', async () => {
    // MEASURED, not claimed. The query is written out as the service builds
    // it - same predicate, same ordering, same limit.
    const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE, BUFFERS)
         SELECT id FROM "expenses"
          WHERE "companyId" = $1::uuid
          ORDER BY "spentAt" DESC, id DESC
          LIMIT 26`,
      COMPANY_A.id,
    );

    const text = plan.map((row) => row['QUERY PLAN']).join('\n');

    console.log(`\n--- EXPLAIN ANALYZE over ${ROWS} rows ---\n${text}\n`);

    // The claim is narrow and checkable: no sequential scan of the table.
    // Which index, and whether it is a plain or backward scan, is the
    // planner's business and is not asserted.
    expect(text).not.toMatch(/Seq Scan on expenses/iu);
    expect(text).toMatch(/Index (Only )?Scan/iu);
  }, 60_000);

  it('F06-T19c: expenses sharing a spentAt to the millisecond still page correctly', async () => {
    // THE REASON THE CURSOR IS A PAIR.
    //
    // `spentAt` is Timestamptz(3) - ONE MILLISECOND of resolution - and it is
    // supplied by the client, so ties are not exotic: a batch import stamps
    // many expenses with the same instant. A cursor on `spentAt` alone would
    // skip or repeat every tied row. Ordering by the UUIDv7 id alone would
    // not match the `spentAt DESC` the API promises, because the id's
    // embedded timestamp is arrival time and `spentAt` is not.
    //
    // So the tie is constructed explicitly rather than hoped for.
    const tied = new Date(Date.now() - 7_200_000);

    for (const suffix of ['tie-a', 'tie-b', 'tie-c']) {
      await prisma.expense.create({
        data: {
          companyId: COMPANY_A.id,
          externalId: `shape-${suffix}`,
          employeeId: `emp-${suffix}`,
          amountMinor: 5_000,
          currency: 'SAR',
          merchant: 'Tied Shop',
          category: 'TRANSPORT',
          spentAt: tied,
          decision: 'APPROVE',
          status: 'APPROVED',
          payloadHash: suffix.padEnd(64, '0'),
          policySnapshot: {},
        },
      });
    }

    const tiedRows = await prisma.expense.findMany({ where: { spentAt: tied } });
    expect(tiedRows).toHaveLength(3);
    // All three genuinely share the stored instant - otherwise this test
    // would be paging through three ordinary rows and proving nothing.
    expect(new Set(tiedRows.map((r) => r.spentAt.getTime())).size).toBe(1);

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 6; page += 1) {
      const result = await expenses.list(
        COMPANY_A.id,
        query({ limit: 1, q: 'Tied Shop', cursor }),
      );

      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor ?? undefined;

      if (!cursor) {
        break;
      }
    }

    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual(tiedRows.map((r) => r.id).sort());

    await prisma.expense.deleteMany({ where: { spentAt: tied } });
  }, 60_000);
});

/** Writes and transaction control are not what this is counting. */
function isSelect(statement: string): boolean {
  return /^\s*SELECT/iu.test(statement);
}
