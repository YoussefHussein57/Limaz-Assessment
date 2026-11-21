import { Suspense } from 'react';
import { CompanyWorkspace } from '@/components/admin/company-workspace';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { isPlatformAdmin } from '@/lib/admin-guard';
import { requireUser } from '@/lib/auth';

/**
 * The platform administration workspace.
 *
 * This page IS the overview. A separate summary screen was considered and
 * rejected: it would have needed either its own aggregate endpoint or figures
 * derived from one page of companies, and the only number worth showing -
 * which companies cannot authenticate - is on the rows themselves.
 *
 * A Server Component shell around a client list, the same split the manager
 * listings use. `Suspense` is required because the list reads the query
 * string with `useSearchParams`.
 */
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  await requireUser();

  // Render NOTHING for a non-administrator. The layout already shows them an
  // explanation; without this the page's output would still travel in the RSC
  // payload behind it (AI_LOG 44).
  if (!(await isPlatformAdmin())) {
    return null;
  }

  return (
    <>
      <PageHeader
        title="Companies"
        description="Every company on this deployment, and the API keys their backends authenticate with."
      />

      <Suspense fallback={<WorkspaceFallback />}>
        <CompanyWorkspace />
      </Suspense>
    </>
  );
}

function WorkspaceFallback() {
  return (
    <div aria-busy="true" aria-label="Loading companies">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 sm:max-w-sm">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-1 h-11 w-full" />
        </div>
        <Skeleton className="h-11 w-40 sm:ml-auto" />
      </div>
      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-5 py-4">
              <div className="flex-1">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="mt-2 h-3 w-60 max-w-full" />
              </div>
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
