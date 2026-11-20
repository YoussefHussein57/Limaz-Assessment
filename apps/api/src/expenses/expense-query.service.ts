import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decodeCursor, encodeCursor } from '../common/keyset';
import { PrismaService } from '../prisma/prisma.service';
import type { ListExpensesDto } from './dto/list-expenses.dto';
import {
  toExpenseDetail,
  toExpenseListItem,
  type ExpenseDetail,
  type ExpensePage,
} from './expense-read.types';

/**
 * Reading expenses, always scoped to the authenticated company.
 *
 * `companyId` goes into the `where` of the query itself, never into a check
 * performed after fetching a global row. The difference is not stylistic: a
 * post-fetch check has already read another tenant's data into this process,
 * and is one early return or one refactor away from leaking it.
 */
@Injectable()
export class ExpenseQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of expenses, newest first by the date the money was SPENT.
   *
   * ---------------------------------------------------------------------
   * WHY `spentAt` AND NOT `receivedAt`
   * ---------------------------------------------------------------------
   *
   * A manager scans this list to answer "what did we spend", which is a
   * question about `spentAt`. There is a real trade-off and it is worth
   * naming: a backdated submission appears partway down the list rather than
   * at the top, so this ordering is NOT an arrival feed. `receivedAt` is
   * returned on every row so the gap is always visible, and the detail view
   * shows both.
   *
   * There is exactly ONE ordering. A second one would need its own index and
   * a cursor that encodes which column it was built from - otherwise a cursor
   * taken under one sort and replayed under another silently pages through
   * nonsense.
   *
   * `@@index([companyId, spentAt])` exists for this query (F01). Whether
   * PostgreSQL actually chooses it is MEASURED with EXPLAIN ANALYZE in
   * `expense-query-shape.e2e-spec.ts`, not asserted here.
   *
   * ---------------------------------------------------------------------
   * STATEMENT COUNT
   * ---------------------------------------------------------------------
   *
   * `include` does NOT necessarily compile to one SQL statement - Prisma may
   * issue one query per relation level and join in memory - and that claim is
   * made nowhere. The property that matters is the one the requirement asks
   * for: the number of statements is bounded by the SHAPE of the query, not
   * by the number of rows, so there is no N+1. Measured for pages of 5 and
   * 50 in `expense-query-shape.e2e-spec.ts`.
   *
   * The list selects only `ruleCode` from the rule hits and only `state` from
   * the review. The full detail and the resolver's identity are on the detail
   * route, where exactly one expense is being read.
   */
  async list(companyId: string, query: ListExpensesDto): Promise<ExpensePage> {
    const where = buildWhere(companyId, query);

    // One extra row, to learn whether another page exists without a second
    // COUNT query - and without claiming there is a next page when there is
    // not, which is what a naive `items.length === limit` does on an exact
    // multiple.
    const rows = await this.prisma.expense.findMany({
      where,
      include: {
        ruleHits: { select: { ruleCode: true } },
        review: { select: { state: true } },
      },
      orderBy: [{ spentAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toExpenseListItem),
      nextCursor: hasMore && last ? encodeCursor({ timestamp: last.spentAt, id: last.id }) : null,
    };
  }

  /**
   * One expense with every reason, the policy snapshot and the human review.
   *
   * An expense belonging to another company answers 404, not 403 (ADR-003).
   * 403 at row level confirms the row exists, which turns the endpoint into
   * an enumeration oracle: a caller could walk ids and learn how many
   * expenses a competitor has. The tenant predicate is in the query, so "not
   * yours" and "not there" are genuinely the same code path rather than two
   * paths that produce the same text.
   *
   * The nested `review` needs no tenant predicate of its own, and that is a
   * guarantee rather than an oversight: `Review(expenseId, companyId)` is a
   * composite foreign key onto `Expense(id, companyId)` (ADR-011), so a
   * review whose company differs from its expense's is physically unstorable.
   */
  async findOne(companyId: string, expenseId: string): Promise<ExpenseDetail> {
    const row = await this.prisma.expense.findFirst({
      where: { id: expenseId, companyId },
      include: {
        ruleHits: true,
        review: { include: { resolvedBy: true } },
      },
    });

    if (!row) {
      throw new NotFoundException({
        error: 'not_found',
        message: 'No such expense.',
      });
    }

    return toExpenseDetail(row);
  }
}

/**
 * The filter set, assembled into ONE `where`.
 *
 * The search term and the cursor both produce an `OR`, and an object cannot
 * carry two `OR` keys - the second would silently replace the first and widen
 * the result set past the cursor. They are therefore combined under `AND`,
 * which is also what makes "search AND paginate" mean what it reads like.
 */
function buildWhere(companyId: string, query: ListExpensesDto): Prisma.ExpenseWhereInput {
  const and: Prisma.ExpenseWhereInput[] = [];

  if (query.q) {
    // `contains`, case-insensitive, across the three fields a manager would
    // actually type. This is content matching and writes nothing; the F03
    // rule that identifiers are compared EXACTLY governs submission, where
    // merging two client identities would be a correctness failure.
    and.push({
      OR: [
        { merchant: { contains: query.q, mode: 'insensitive' } },
        { externalId: { contains: query.q, mode: 'insensitive' } },
        { employeeId: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }

  if (query.cursor) {
    and.push(keysetBefore(query.cursor));
  }

  return {
    companyId,
    ...(query.status === 'ALL' ? {} : { status: query.status }),
    ...(query.decision === 'ALL' ? {} : { decision: query.decision }),
    ...(query.category ? { category: query.category } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

/**
 * `(spentAt, id) < (cursorSpentAt, cursorId)`, expanded.
 *
 * PostgreSQL supports the row-value form directly, but Prisma's typed API
 * does not, so it is written out: strictly older, OR the same instant with a
 * smaller id. Those two branches are what make the ordering total - without
 * the second, two expenses sharing a `spentAt` to the millisecond (the
 * column's full resolution) would be skipped or repeated forever.
 *
 * This compares VALUES. It never looks the cursor row up, so it keeps working
 * if that expense stops matching the filters between one page and the next.
 */
function keysetBefore(cursor: string): Prisma.ExpenseWhereInput {
  const { timestamp: spentAt, id } = decodeCursor(cursor);

  return {
    OR: [{ spentAt: { lt: spentAt } }, { spentAt, id: { lt: id } }],
  };
}
