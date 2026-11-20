import { Injectable } from '@nestjs/common';
import type { ExpenseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CategoryList,
  CurrencyTotal,
  DashboardSummary,
  FlaggedBreakdown,
} from './summary.types';

/**
 * The dashboard aggregate.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE groupBy AND NOT FOUR COUNTS
 * ---------------------------------------------------------------------------
 *
 * Four `count()` calls are four statements, therefore four MVCC snapshots. An
 * expense submitted between the second and the third is counted by one and
 * not the other, and the dashboard shows status counts that do not sum to the
 * total. Nothing errors; the numbers are simply wrong, intermittently, in a
 * way nobody can reproduce.
 *
 * One `groupBy` is one statement and one snapshot. The figures add up because
 * they were all read from the same instant, not because the code is careful.
 *
 * Rejected alternatives:
 *
 *   - Counting in the browser from a fetched page. Counts the PAGE, not the
 *     company. Wrong by construction as soon as there is a second page.
 *   - A materialised or cached statistic. Adds an invalidation problem to a
 *     query that reads a handful of grouped rows, to solve a performance
 *     problem nobody has measured.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GROUPING INCLUDES `decision`
 * ---------------------------------------------------------------------------
 *
 * The status counts answer "where do things stand". They cannot answer "how
 * much did a human have to judge", because an APPROVED expense may have been
 * auto-approved or approved by a manager after being flagged. Adding
 * `decision` to the same grouping answers both from the same snapshot, at no
 * extra statement.
 */
@Injectable()
export class DashboardSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summarise(companyId: string): Promise<DashboardSummary> {
    // ONE statement. The tenant predicate is in it, not applied afterwards -
    // an aggregate computed globally and filtered later has already read
    // every other company's spending into this process.
    const groups = await this.prisma.expense.groupBy({
      by: ['status', 'decision', 'currency'],
      where: { companyId },
      _count: { _all: true },
      _sum: { amountMinor: true },
    });

    const byStatus: Record<ExpenseStatus, number> = {
      APPROVED: 0,
      REJECTED: 0,
      PENDING_REVIEW: 0,
    };

    const flagged = { total: 0, pending: 0, approvedByManager: 0, rejectedByManager: 0 };
    const amounts = new Map<string, number>();
    let total = 0;

    for (const group of groups) {
      const count = group._count._all;

      total += count;
      byStatus[group.status] += count;

      // `_sum` is null only for an empty group, which `groupBy` does not
      // return. Defaulted anyway rather than asserted - the type says it can
      // be null and a runtime `!` would be a claim about Prisma's behaviour
      // rather than about this code.
      amounts.set(group.currency, (amounts.get(group.currency) ?? 0) + (group._sum.amountMinor ?? 0));

      if (group.decision === 'REVIEW') {
        flagged.total += count;

        if (group.status === 'PENDING_REVIEW') {
          flagged.pending += count;
        } else if (group.status === 'APPROVED') {
          flagged.approvedByManager += count;
        } else {
          flagged.rejectedByManager += count;
        }
      }
    }

    return {
      total,
      byStatus,
      flagged: flagged as FlaggedBreakdown,
      amounts: toCurrencyTotals(amounts),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Every category this company has actually used.
   *
   * ---------------------------------------------------------------------
   * WHY THIS ENDPOINT EXISTS AT ALL
   * ---------------------------------------------------------------------
   *
   * F06 built the category filter from the categories present in the page
   * being displayed. That is wrong in a specific and misleading way: a
   * company whose rarer categories only appear on page three cannot select
   * one from page one, and - worse - the control LOOKS like the company's
   * complete category list. A filter that silently offers a subset is harder
   * to notice than one that is missing (R-29).
   *
   * Three options were considered. Deriving it from the dashboard aggregate
   * would mean adding `category` to that `groupBy`, multiplying its row count
   * for a value nothing else there needs. Removing the filter was allowed by
   * the brief but loses a real affordance. This is the third: one small,
   * bounded, tenant-scoped query that answers exactly the question.
   *
   * ---------------------------------------------------------------------
   * WHY IT LIVES IN THE DASHBOARD NAMESPACE
   * ---------------------------------------------------------------------
   *
   * `GET /v1/expenses/categories` would collide with
   * `GET /v1/expenses/:expenseId`. Nest resolves that by declaration order,
   * so it works until somebody reorders the methods and `categories` starts
   * being parsed as an expense id. That is the same trap `summary` avoided,
   * and it is avoided the same way.
   *
   * ONE statement: `SELECT DISTINCT` with the tenant predicate inside it.
   */
  async listCategories(companyId: string): Promise<CategoryList> {
    const rows = await this.prisma.expense.findMany({
      where: { companyId },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
      // One more than the cap, so truncation is DETECTED rather than assumed
      // from a full page - the same trick the keyset listings use.
      take: MAX_CATEGORIES + 1,
    });

    const truncated = rows.length > MAX_CATEGORIES;

    return {
      categories: (truncated ? rows.slice(0, MAX_CATEGORIES) : rows).map((row) => row.category),
      // Said out loud, so the UI can tell the reader the list is incomplete
      // instead of presenting a truncated list as the whole set - which is
      // the exact mistake this endpoint exists to fix.
      truncated,
    };
  }
}

/**
 * The maximum number of categories the filter endpoint will return.
 *
 * Bounded for the same reason every listing is: a company with a pathological
 * number of distinct categories must not be able to produce an unbounded
 * response. 200 is far above anything a real expense vocabulary reaches, and
 * the response says when it was truncated rather than silently cutting off.
 */
export const MAX_CATEGORIES = 200;

/** Sorted by code, so two identical companies produce identical responses. */
function toCurrencyTotals(amounts: ReadonlyMap<string, number>): CurrencyTotal[] {
  return [...amounts.entries()]
    .map(([currency, totalMinor]) => ({ currency, totalMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
