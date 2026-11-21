import { Suspense } from 'react';
import { ExpenseList } from '@/components/expenses/expense-list';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { RoleDenied } from '@/components/layout/role-denied';
import { requireUser } from '@/lib/auth';
import { DISPLAY_TIME_ZONE_LABEL } from '@/lib/format';

/**
 * The expense listing.
 *
 * A SERVER COMPONENT that renders a client one. The shell - heading, page
 * description, the company's identity - is resolved on the server, and only
 * the part that genuinely needs interactivity ships as JavaScript.
 *
 * `Suspense` is required rather than optional: `ExpenseList` calls
 * `useSearchParams`, and a client component that reads the URL's query string
 * forces the route to be rendered on demand. Without a boundary Next refuses
 * to build the page.
 */
export const dynamic = 'force-dynamic';

export default async function ExpensesPage() {
  const user = await requireUser();

  // An administrator has no company workspace: `companyId` is null by
  // construction. Refused HERE, before any `serverFetch`, so the screen says
  // why rather than letting the API's 403 surface as 'the server did not
  // answer' (AI_LOG 47).
  if (user.role !== 'MANAGER') {
    return <RoleDenied audience="manager" />;
  }

  return (
    <>
      <PageHeader
        title="Expenses"
        description={
          user.company
            ? `Everything ${user.company.name} has submitted, newest first by the date the money was spent.`
            : 'Newest first by the date the money was spent.'
        }
      />

      <Suspense fallback={<ListFallback />}>
        <ExpenseList />
      </Suspense>

      <p className="mt-4 text-xs text-text-secondary">
        Ordered by when the money was spent, not when it arrived - a backdated expense appears in
        date order rather than at the top. Times are shown in {DISPLAY_TIME_ZONE_LABEL}.
      </p>
    </>
  );
}

/** Matches the real layout: a filter row, then rows at the real height. */
function ListFallback() {
  return (
    <div aria-busy="true" aria-label="Loading expenses">
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-1 h-11 w-full" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="divide-y divide-border">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="hidden h-4 w-20 sm:block" />
              <Skeleton className="ml-auto h-4 w-24" />
              <Skeleton className="hidden h-5 w-24 rounded-full md:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
