import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shown while the server renders the overview.
 *
 * The shapes and sizes match the real page: four cards in the same grid, a
 * card below with rows at the same height. The point is that nothing MOVES
 * when the data arrives - a skeleton that is the wrong size guarantees a jump,
 * which is worse than showing nothing at all.
 *
 * `aria-busy` on the region, and no text: a screen reader gains nothing from
 * hearing a description of grey rectangles.
 *
 * There is NO artificial delay anywhere that makes this easier to see. If it
 * flashes past on a fast connection, that is the correct outcome.
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the overview">
      <div className="mb-6">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-card border border-border bg-surface p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-8 w-16" />
            <Skeleton className="mt-3 h-3 w-28" />
          </div>
        ))}
      </div>

      <div className="mt-6 overflow-hidden rounded-card border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }, (_, index) => (
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
