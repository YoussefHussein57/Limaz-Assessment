import Link from 'next/link';
import { ArrowRight, Inbox } from 'lucide-react';
import { StatCard } from '@/components/dashboard/stat-card';
import { ExpenseRows } from '@/components/expenses/expense-rows';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { serverFetch } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import type { DashboardSummary, ExpensePage } from '@/lib/expense-types';
import { DISPLAY_TIME_ZONE_LABEL, formatMoney, pluralise } from '@/lib/format';

/**
 * The manager overview.
 *
 * ---------------------------------------------------------------------------
 * A SERVER COMPONENT, AND WHY
 * ---------------------------------------------------------------------------
 *
 * Nothing on this page has a parameter the reader can change. There is no
 * search, no filter and no pagination - so there is nothing for a client cache
 * to be a cache OF. Rendering on the server means the figures are in the first
 * HTML: no spinner, no round trip after hydration, no JavaScript shipped to
 * fetch them, and no copy of a company's spending sitting in a browser cache.
 *
 * The listing next door is the opposite case and is a Client Component for
 * exactly the reasons this one is not.
 *
 * `force-dynamic` because the answer is per-user. A cached dashboard is how
 * one company's numbers appear on another company's screen.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER HERE IS REAL
 * ---------------------------------------------------------------------------
 *
 * There is no trend, no percentage change, no sparkline and no activity feed.
 * Each of those would have to be invented - the system records no history of
 * its own counts - and an invented figure is one nobody can defend when asked
 * where it came from.
 *
 * The counts come from ONE `groupBy` on the server, so they are a single
 * database snapshot and the three statuses sum to the total by construction.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await requireUser();

  // Fetched in parallel: two independent requests, so awaiting them in
  // sequence would add the slower one's latency to the faster one's for no
  // reason. `Promise.all` rejects on the first failure, which is what the
  // error boundary is for.
  const [summary, recent] = await Promise.all([
    serverFetch<DashboardSummary>('/v1/dashboard/summary'),
    serverFetch<ExpensePage>('/v1/expenses?limit=5'),
  ]);

  const { byStatus, flagged } = summary;
  const pending = byStatus.PENDING_REVIEW;

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          user.company
            ? `Every expense ${user.company.name} has submitted, counted by its current status.`
            : 'Your company workspace.'
        }
      />

      <section aria-label="Summary">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Total expenses"
            value={summary.total}
            note={
              summary.amounts.length > 0
                ? // Per currency, never summed across them. A company has one
                  // currency (A3), so this prints one line - but the aggregate
                  // does not DEPEND on that, and neither does this.
                  summary.amounts
                    .map((amount) => formatMoney(amount.totalMinor, amount.currency))
                    .join(' · ') + ' all time'
                : undefined
            }
            href="/dashboard/expenses"
          />

          <StatCard
            label="Approved"
            value={byStatus.APPROVED}
            // The distinction the rest of this system is built on, stated on
            // the card: an expense the policy flagged and a manager approved
            // is APPROVED, and it is worth knowing how many of them there are.
            note={
              flagged.approvedByManager > 0
                ? `${flagged.approvedByManager} approved by a manager`
                : 'All approved automatically'
            }
            href="/dashboard/expenses?status=APPROVED"
          />

          <StatCard
            label="Pending review"
            value={pending}
            note={pending > 0 ? 'Waiting on a decision' : 'Nothing waiting'}
            tone={pending > 0 ? 'warning' : 'neutral'}
            href="/dashboard/expenses?status=PENDING_REVIEW"
          />

          <StatCard
            label="Rejected"
            value={byStatus.REJECTED}
            note={
              flagged.rejectedByManager > 0
                ? `${flagged.rejectedByManager} rejected by a manager`
                : 'All rejected by policy'
            }
            href="/dashboard/expenses?status=REJECTED"
          />
        </div>
      </section>

      {pending > 0 ? (
        <div className="mt-4">
          <Alert tone="info" title={`${pluralise(pending, 'expense')} waiting for a decision`}>
            <Link href="/dashboard/reviews" className="font-medium underline underline-offset-2">
              Go to reviews
            </Link>{' '}
            to approve or reject.
          </Alert>
        </div>
      ) : null}

      <section aria-label="Recent expenses" className="mt-6">
        <Card className="overflow-hidden">
          {/* Not `CardHeader`: this one needs an action in the same row, and
              widening the shared component for one call site would push the
              variation into every other card that does not want it. */}
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-text">Recent expenses</h2>
            <Link
              href="/dashboard/expenses"
              className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
            >
              View all expenses
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>

          {recent.items.length === 0 ? (
            <EmptyState
              Icon={Inbox}
              title="No expenses yet"
              description="Expenses appear here as soon as your integration submits them to the API."
            />
          ) : (
            <ExpenseRows items={recent.items} />
          )}
        </Card>
      </section>

      <p className="mt-4 text-xs text-text-secondary">
        Figures cover all time and use each expense&rsquo;s current status. Times are shown in{' '}
        {DISPLAY_TIME_ZONE_LABEL}.
      </p>
    </>
  );
}
