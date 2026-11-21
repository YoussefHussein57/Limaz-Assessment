import { Suspense } from 'react';
import { WebhookEventHistory } from '@/components/admin/webhook-event-history';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { isPlatformAdmin } from '@/lib/admin-guard';
import { requireUser } from '@/lib/auth';

/**
 * Every card webhook this deployment has accepted (F12).
 *
 * `Suspense` is required because the list reads the query string with
 * `useSearchParams`, the same reason the companies page needs one.
 */
export const dynamic = 'force-dynamic';

export default async function WebhookEventsPage() {
  await requireUser();

  if (!(await isPlatformAdmin())) {
    return null;
  }

  return (
    <>
      <PageHeader
        title="Webhook events"
        description="What the card providers actually delivered, and what became of it."
      />

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <WebhookEventHistory />
      </Suspense>
    </>
  );
}
