import { Injectable } from '@nestjs/common';
import type { ExpenseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CurrencyTotal, DashboardSummary, FlaggedBreakdown } from './summary.types';

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
}

/** Sorted by code, so two identical companies produce identical responses. */
function toCurrencyTotals(amounts: ReadonlyMap<string, number>): CurrencyTotal[] {
  return [...amounts.entries()]
    .map(([currency, totalMinor]) => ({ currency, totalMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
