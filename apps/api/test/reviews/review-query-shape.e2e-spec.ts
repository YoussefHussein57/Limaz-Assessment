import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { COMPANY_A } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { ReviewQueryService } from '../../src/reviews/review-query.service';
import { testDatabaseUrl } from '../database-url';
import { resetDatabase } from '../test-db';

/**
 * How many SQL statements a page of reviews actually costs.
 *
 * `include` is widely assumed to compile to one joined query. It does not
 * always: Prisma may issue one statement per relation LEVEL and stitch the
 * results together in memory. That is fine, and it is not what the
 * requirement forbids.
 *
 * The property that matters is that the statement count is bounded by the
 * SHAPE of the query and not by the NUMBER OF ROWS - which is the definition
 * of "no N+1". So it is measured: the same page is fetched at two very
 * different sizes and the statement counts are compared.
 *
 * A dedicated client is built here with query logging on, because the
 * application's PrismaService is shared and turning logging on globally would
 * affect every other suite.
 */
describe('F05 review query shape', () => {
  let prisma: PrismaClient;
  let service: ReviewQueryService;
  // Initialised HERE, not in beforeEach: the query listener is attached in
  // beforeAll, which runs first, and would otherwise push into undefined.
  let statements: string[] = [];

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

    // Enough reviews that an N+1 would be unmistakable.
    const expenses = Array.from({ length: 60 }, (_, i) => ({
      companyId: COMPANY_A.id,
      externalId: `shape-${i}`,
      employeeId: `emp-shape-${i}`,
      amountMinor: 60_000,
      currency: 'SAR',
      merchant: 'Shop',
      category: 'TRANSPORT',
      spentAt: new Date(Date.now() - 600_000),
      decision: 'REVIEW' as const,
      status: 'PENDING_REVIEW' as const,
      payloadHash: `shape-${i}`.padEnd(64, '0'),
      policySnapshot: {},
    }));

    await prisma.expense.createMany({ data: expenses });

    const created = await prisma.expense.findMany({
      where: { externalId: { startsWith: 'shape-' } },
      select: { id: true },
    });

    await prisma.ruleHit.createMany({
      data: created.map((e) => ({
        expenseId: e.id,
        ruleCode: 'AMOUNT_LIMIT' as const,
        decision: 'REVIEW' as const,
        detail: { autoApproveLimitMinor: 50_000, amountMinor: 60_000 },
      })),
    });

    await prisma.review.createMany({
      data: created.map((e) => ({ expenseId: e.id, companyId: COMPANY_A.id })),
    });

    service = new ReviewQueryService(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    statements = [];
  });

  it('the statement count does not grow with the number of rows', async () => {
    statements = [];
    const small = await service.list(COMPANY_A.id, { state: 'OPEN', limit: 5 });
    const forFive = statements.filter(isSelect).length;

    statements = [];
    const large = await service.list(COMPANY_A.id, { state: 'OPEN', limit: 50 });
    const forFifty = statements.filter(isSelect).length;

    expect(small.items).toHaveLength(5);
    expect(large.items).toHaveLength(50);

    // THE ASSERTION THAT MATTERS. Ten times the rows, the same number of
    // statements. An N+1 would make the second number roughly ten times the
    // first.
    expect(forFifty).toBe(forFive);

    // And it is a small, bounded number - one per relation level at most.
    expect(forFive).toBeLessThanOrEqual(4);

    // Printed so the real figure is in the record rather than described.
    console.log(`\n--- statements per page: ${forFive} for 5 rows, ${forFifty} for 50 rows ---\n`);
  }, 60_000);

  it('a page never returns more rows than it was asked for', async () => {
    const page = await service.list(COMPANY_A.id, { state: 'OPEN', limit: 10 });

    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();

    // The response is bounded by the caller's limit, which is itself bounded
    // by MAX_PAGE_SIZE - so no request can ask for an unbounded body.
  });

  it('the cursor keeps working after the row it names is resolved', async () => {
    // The case Prisma's own `cursor` option cannot serve: it looks the row up,
    // and here that row leaves the OPEN set by design.
    const first = await service.list(COMPANY_A.id, { state: 'OPEN', limit: 5 });
    const cursor = first.nextCursor!;
    const lastOfPage = first.items.at(-1)!;

    await prisma.review.update({
      where: { id: lastOfPage.id },
      data: {
        state: 'RESOLVED',
        outcome: 'APPROVED',
        resolvedByUserId: (
          await prisma.user.findFirstOrThrow({
            where: { companyId: COMPANY_A.id, role: 'MANAGER' },
          })
        ).id,
        resolvedAt: new Date(),
      },
    });

    // The cursor names a review that is no longer in the result set. Because
    // it is compared as a VALUE rather than looked up, the next page is still
    // correct.
    const second = await service.list(COMPANY_A.id, { state: 'OPEN', limit: 5, cursor });

    expect(second.items).toHaveLength(5);
    expect(second.items.map((r) => r.id)).not.toContain(lastOfPage.id);

    for (const item of second.items) {
      expect(first.items.map((r) => r.id)).not.toContain(item.id);
    }
  }, 60_000);

  it('reviews sharing a createdAt to the millisecond still page correctly', async () => {
    // THE REASON THE CURSOR IS A PAIR.
    //
    // The first version of this test asserted that rows created in one
    // transaction share a createdAt, because the column is declared
    // DEFAULT CURRENT_TIMESTAMP and that is transaction-start time. They do
    // NOT: Prisma supplies the value per row from the client, so the default
    // never fires. The assumption was wrong and the test caught it.
    //
    // The real exposure is simpler and does not depend on transactions at
    // all:  is Timestamptz(3), so its resolution is ONE
    // MILLISECOND. Any bulk insert, import or backfill can produce rows that
    // tie. A cursor on createdAt alone would then skip or repeat whichever
    // rows share that instant, and ordering by the UUIDv7 id alone would not
    // match the createdAt ordering the API promises - the two values come
    // from different sources and need not agree.
    //
    // So the tie is constructed explicitly here rather than hoped for.
    const tied = new Date(Date.now() - 3_600_000);

    const expenses = await Promise.all(
      ['tie-a', 'tie-b', 'tie-c'].map((suffix) =>
        prisma.expense.create({
          data: {
            companyId: COMPANY_A.id,
            externalId: `shape-${suffix}`,
            employeeId: `emp-${suffix}`,
            amountMinor: 60_000,
            currency: 'SAR',
            merchant: 'Shop',
            category: 'TRANSPORT',
            spentAt: new Date(Date.now() - 600_000),
            decision: 'REVIEW',
            status: 'PENDING_REVIEW',
            payloadHash: suffix.padEnd(64, '0'),
            policySnapshot: {},
          },
        }),
      ),
    );

    await prisma.review.createMany({
      data: expenses.map((expense) => ({
        expenseId: expense.id,
        companyId: COMPANY_A.id,
        createdAt: tied,
        updatedAt: tied,
      })),
    });

    const tiedRows = await prisma.review.findMany({ where: { createdAt: tied } });
    expect(tiedRows).toHaveLength(3);
    expect(new Set(tiedRows.map((r) => r.createdAt.toISOString())).size).toBe(1);

    // Page one row at a time across the whole set, including the three that
    // share an instant. Nothing may be skipped and nothing repeated - the
    // property the second branch of the keyset predicate exists for.
    const seen: string[] = [];
    let cursor: string | null = null;
    const total = await prisma.review.count({ where: { companyId: COMPANY_A.id, state: 'OPEN' } });

    for (let i = 0; i < total + 2; i += 1) {
      const page: Awaited<ReturnType<ReviewQueryService['list']>> = await service.list(
        COMPANY_A.id,
        { state: 'OPEN', limit: 1, ...(cursor ? { cursor } : {}) },
      );

      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;

      if (!cursor) {
        break;
      }
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    for (const review of tiedRows) {
      expect(seen).toContain(review.id);
    }
  }, 120_000);
});

function isSelect(statement: string): boolean {
  return /^\s*SELECT/iu.test(statement);
}
