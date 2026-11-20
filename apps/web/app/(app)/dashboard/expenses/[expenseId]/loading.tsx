import { Skeleton } from '@/components/ui/skeleton';

/** The detail page's own shape, so nothing moves when the data arrives. */
export default function ExpenseDetailLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the expense">
      <Skeleton className="h-4 w-32" />

      <div className="mt-4 mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="mt-2 h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-5 w-44" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="rounded-card border border-border bg-surface">
              <div className="border-b border-border px-5 py-4">
                <Skeleton className="h-4 w-48" />
              </div>
              <div className="flex flex-col gap-3 px-5 py-4">
                <Skeleton className="h-4 w-64 max-w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-40" />
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-4">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="rounded-card border border-border bg-surface">
              <div className="border-b border-border px-5 py-4">
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex flex-col gap-3 px-5 py-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
