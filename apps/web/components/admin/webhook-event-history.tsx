'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { adminKeys, fetchCompanies } from '@/lib/admin-queries';
import { userMessage } from '@/lib/api-error';
import { formatDateTime, pluralise } from '@/lib/format';
import { EVENT_PAGE_SIZE, fetchWebhookEvents, webhookKeys } from '@/lib/webhook-queries';
import type { WebhookEventStatus, WebhookEventSummary } from '@/lib/webhook-types';

/**
 * Every card webhook this deployment has accepted (F12).
 *
 * ---------------------------------------------------------------------------
 * READ ONLY, BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * There is no retry button, no cancel, and no edit. Each one would be a way to
 * change what the policy engine already decided, from a screen whose job is to
 * explain what happened - and a retry in particular would be a second delivery
 * that the provider never sent.
 *
 * A stuck event is handled by the worker's own retry schedule. A terminal one
 * is a question for the provider.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW DOES NOT SHOW
 * ---------------------------------------------------------------------------
 *
 * No payload, no payload hash, no signature, no headers. The API does not send
 * them, so there is nothing here to leak - the shape is built field by field
 * on the server for exactly that reason.
 */
export function WebhookEventHistory() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const companyId = searchParams.get('companyId') ?? '';
  const status = searchParams.get('status') ?? '';
  const cursor = searchParams.get('cursor');

  const [trail, setTrail] = useState<(string | null)[]>([]);

  const write = useCallback(
    (next: { companyId?: string; status?: string; cursor?: string | null }) => {
      const params = new URLSearchParams();
      const nextCompany = next.companyId ?? companyId;
      const nextStatus = next.status ?? status;

      if (nextCompany) params.set('companyId', nextCompany);
      if (nextStatus) params.set('status', nextStatus);
      if (next.cursor) params.set('cursor', next.cursor);

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [companyId, pathname, router, status],
  );

  const companies = useQuery({
    queryKey: adminKeys.companyList('', null),
    queryFn: ({ signal }) => fetchCompanies('', null, signal),
  });

  const query = useQuery({
    queryKey: webhookKeys.eventList(companyId, status, cursor),
    queryFn: ({ signal }) => fetchWebhookEvents(companyId, status, cursor, signal),
    placeholderData: keepPreviousData,
    // The inbox changes while somebody is looking at it, and a stale list is
    // actively misleading when the question is "did it process?". Bounded,
    // and only while this screen is mounted.
    refetchInterval: 4_000,
  });

  const events = query.data?.items ?? [];

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-end sm:px-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="event-company" className="text-xs font-medium text-text-secondary">
            Company
          </label>
          <select
            id="event-company"
            value={companyId}
            onChange={(event) => {
              setTrail([]);
              write({ companyId: event.target.value, cursor: null });
            }}
            className="h-10 rounded-control border border-border-input bg-surface px-3 text-sm text-text"
          >
            <option value="">All companies</option>
            {(companies.data?.items ?? []).map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="event-status" className="text-xs font-medium text-text-secondary">
            Processing state
          </label>
          <select
            id="event-status"
            value={status}
            onChange={(event) => {
              setTrail([]);
              write({ status: event.target.value, cursor: null });
            }}
            className="h-10 rounded-control border border-border-input bg-surface px-3 text-sm text-text"
          >
            <option value="">Any state</option>
            <option value="PENDING">Waiting</option>
            <option value="PROCESSING">Processing</option>
            <option value="PROCESSED">Processed</option>
            <option value="FAILED">Failed</option>
            <option value="IGNORED">Ignored</option>
          </select>
        </div>

        <p className="text-xs text-text-secondary sm:ml-auto sm:pb-2.5">
          Read only. Refreshed every few seconds.
        </p>
      </div>

      <div aria-live="polite" className="sr-only">
        {query.isLoading
          ? 'Loading webhook events'
          : query.isError
            ? 'Could not load webhook events'
            : `${pluralise(events.length, 'event')} shown`}
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : query.isError ? (
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title="Could not load the event history"
          description={userMessage(query.error)}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : events.length === 0 ? (
        <EmptyState
          Icon={Inbox}
          title={companyId || status ? 'Nothing matches those filters' : 'No webhook events yet'}
          description={
            companyId || status
              ? 'Try a wider filter.'
              : 'Deliveries appear here once a card provider — or the sandbox simulator — sends one. A delivery refused for a bad signature is never stored, so it will not appear.'
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ul>
      )}

      {events.length > 0 ? (
        <nav
          aria-label="Event pages"
          className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center"
        >
          <p className="text-sm text-text-secondary">
            {pluralise(events.length, 'event')} on page {trail.length + 1}
          </p>

          <div className="flex gap-2 sm:ml-auto">
            <Button
              variant="secondary"
              size="sm"
              disabled={cursor === null || query.isFetching}
              onClick={() =>
                setTrail((previous) => {
                  const next = [...previous];
                  write({ cursor: next.pop() ?? null });

                  return next;
                })
              }
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              {trail.length > 0 ? 'Newer' : 'First page'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!query.data?.nextCursor || query.isFetching}
              onClick={() => {
                const next = query.data?.nextCursor;

                if (next) {
                  setTrail((previous) => [...previous, cursor]);
                  write({ cursor: next });
                }
              }}
            >
              Older
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </nav>
      ) : null}

      <p className="border-t border-border px-4 py-3 text-xs text-text-secondary sm:px-5">
        Showing up to {EVENT_PAGE_SIZE} per page. A delivery that failed signature verification is
        refused before anything is stored, so it is deliberately absent here rather than recorded
        as rejected.
      </p>
    </div>
  );
}

function EventRow({ event }: { event: WebhookEventSummary }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs break-all text-text">{event.providerEventId}</span>
        <StatusBadge status={event.status} />
        {event.decision ? (
          <Badge
            tone={
              event.decision === 'REJECT'
                ? 'danger'
                : event.decision === 'REVIEW'
                  ? 'warning'
                  : 'success'
            }
          >
            {event.decision}
          </Badge>
        ) : null}
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
        <span className="break-words">{event.companyName}</span>
        <span aria-hidden="true">·</span>
        <span>{event.eventType}</span>
        <span aria-hidden="true">·</span>
        <span>Received {formatDateTime(event.receivedAt)}</span>
        {event.attempts > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{pluralise(event.attempts, 'attempt')}</span>
          </>
        ) : null}
      </p>

      {event.expenseId ? (
        <p className="text-xs text-text-secondary">
          Expense <span className="font-mono break-all">{event.expenseId}</span>
          {event.expenseStatus ? ` — now ${event.expenseStatus.replace('_', ' ').toLowerCase()}` : ''}
        </p>
      ) : null}

      {event.lastError ? (
        // Sanitised where it was written. Never a stack trace or a query.
        <p className="rounded-control bg-danger-bg px-2 py-1.5 text-xs break-words text-danger">
          {event.lastError}
        </p>
      ) : null}

      {event.status === 'PENDING' && event.nextAttemptAt ? (
        <p className="text-xs text-text-secondary">
          Next attempt {formatDateTime(event.nextAttemptAt)}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The processing state, in words a person can act on.
 *
 * `IGNORED` is deliberately neutral rather than a warning: a valid event of a
 * type this service does not handle is a correct outcome, not a problem.
 */
function StatusBadge({ status }: { status: WebhookEventStatus }) {
  switch (status) {
    case 'PROCESSED':
      return <Badge tone="success">Processed</Badge>;
    case 'FAILED':
      return <Badge tone="danger">Failed</Badge>;
    case 'PROCESSING':
      return <Badge tone="neutral">Processing</Badge>;
    case 'IGNORED':
      return <Badge tone="neutral">Ignored</Badge>;
    default:
      return <Badge tone="warning">Waiting</Badge>;
  }
}
