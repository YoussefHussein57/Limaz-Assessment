import { Suspense } from 'react';
import { ReviewList } from '@/components/reviews/review-list';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { requireUser } from '@/lib/auth';
import { DISPLAY_TIME_ZONE_LABEL } from '@/lib/format';

/**
 * The review queue.
 *
 * A Server Component shell around a client list, the same split the expense
 * listing uses: the heading and the company name are resolved on the server,
 * and only the part with changing parameters ships as JavaScript.
 *
 * `Suspense` is required, not decorative - `ReviewList` reads the query
 * string with `useSearchParams`, and Next refuses to build a route whose
 * client component does that without a boundary.
 */
export const dynamic = 'force-dynamic';

export default async function ReviewsPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader
        title="Reviews"
        description={
          user.company
            ? `Expenses the policy flagged for ${user.company.name}. Approving or rejecting one sets the final status of that expense.`
            : 'Expenses the policy flagged for a human decision.'
        }
      />

      <Suspense fallback={<QueueFallback />}>
        <ReviewList />
      </Suspense>

      <p className="mt-4 text-xs text-text-secondary">
        Newest first. Times are shown in {DISPLAY_TIME_ZONE_LABEL}.
      </p>
    </>
  );
}

function QueueFallback() {
  return (
    <div aria-busy="true" aria-label="Loading reviews">
      <div className="mb-4 max-w-xs">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-1 h-11 w-full" />
      </div>
      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2 px-5 py-4">
              <div className="flex justify-between gap-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-3 w-64 max-w-full" />
              <Skeleton className="h-5 w-32 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
