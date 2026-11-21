'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ReasonList } from '@/components/expenses/reason-card';
import { DecisionBadge, ReviewBadge, StatusBadge } from '@/components/expenses/status-badges';
import { ApiError, userMessage } from '@/lib/api-error';
import { readPolicySnapshot } from '@/lib/expense-types';
import { DISPLAY_TIME_ZONE_LABEL, formatDateTime, formatMoney } from '@/lib/format';
import { fetchReview, reviewKeys } from '@/lib/review-queries';
import { ResolveActions } from './resolve-actions';

/**
 * One review, with the actions that resolve it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE IS A CLIENT COMPONENT WHEN THE EXPENSE DETAIL IS NOT
 * ---------------------------------------------------------------------------
 *
 * The expense detail has no parameters the reader can change, so it is
 * rendered on the server with nothing cached in the browser. This page has a
 * MUTATION, and the mutation's whole job is to change what this page shows -
 * including in the case where somebody else changed it first.
 *
 * Fetching it through the same cache the mutation invalidates means one
 * source of truth for "what does the server say about this review right now".
 * Rendering it on the server and then mutating from a child would leave the
 * server's HTML and the client's cache disagreeing after a 409, and the
 * reader looking at a stale "Open" above a message saying it was resolved.
 *
 * ---------------------------------------------------------------------------
 * THE THREE FACTS, AGAIN
 * ---------------------------------------------------------------------------
 *
 * Policy decision, current expense status, human outcome. They are allowed to
 * disagree and the page says why - exactly as the expense detail does, and
 * reusing its components so the two cannot drift apart.
 */
export function ReviewDetailView({ reviewId }: { reviewId: string }) {
  const query = useQuery({
    queryKey: reviewKeys.detail(reviewId),
    queryFn: ({ signal }) => fetchReview(reviewId, signal),
    // No stale window. This page is where a decision gets made, and showing
    // a thirty-second-old "Open" to somebody about to press Approve is the
    // one place in this application that cannot afford it.
    staleTime: 0,
  });

  if (query.isLoading) {
    return <DetailSkeleton />;
  }

  if (query.isError) {
    const error = query.error;
    const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);

    return (
      <div className="rounded-card border border-border bg-surface">
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title={missing ? 'That review is not here' : 'Could not load this review'}
          description={
            missing
              ? "It does not exist, or it belongs to another company. The dashboard only ever shows your own company's reviews."
              : userMessage(error)
          }
          action={
            missing ? (
              <Link
                href="/dashboard/reviews"
                className="inline-flex h-11 items-center rounded-control border border-border-input bg-surface px-4 text-sm font-medium text-text transition-colors duration-150 hover:bg-surface-subtle"
              >
                Back to reviews
              </Link>
            ) : (
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            )
          }
        />
      </div>
    );
  }

  const review = query.data!;
  const { expense } = review;
  const snapshot = readPolicySnapshot(review.policySnapshot);

  return (
    <>
      <Link
        href="/dashboard/reviews"
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to reviews
      </Link>

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold break-words text-text sm:text-2xl">
            {expense.merchant}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
            <span className="font-mono text-xs">{expense.externalId}</span>
            <span aria-hidden="true">·</span>
            <span>{expense.category}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDateTime(expense.spentAt)}</span>
          </p>
        </div>

        <div className="shrink-0 sm:text-right">
          <p className="tabular text-2xl font-semibold tracking-tight text-text">
            {formatMoney(expense.amountMinor, expense.currency)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 sm:justify-end">
            <DecisionBadge decision={expense.decision} />
            <StatusBadge status={expense.status} />
            <ReviewBadge state={review.state} outcome={review.resolution?.outcome ?? null} />
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex flex-col gap-4">
          {/* The decision box first on every screen size. It is what the
              reader came to do, and burying it under evidence they have to
              scroll past is how a queue stops getting worked. */}
          <Card>
            <CardHeader
              title="Your decision"
              description={
                review.state === 'OPEN'
                  ? 'Approving or rejecting sets the final status of this expense.'
                  : 'This review has already been decided.'
              }
            />
            <ResolveActions review={review} />
          </Card>

          <Card>
            <CardHeader
              title="Why the policy flagged this"
              description="Every rule that fired, with the evidence the engine recorded at the time."
            />
            <ReasonList reasons={review.reasons} currency={expense.currency} />
          </Card>

          <Card>
            <CardHeader
              title="Policy in force when this was judged"
              description="A snapshot taken at submission. Changing the policy today does not change this expense."
            />

            {snapshot ? (
              <dl className="text-sm">
                <Row label="Auto-approval limit">
                  <span className="tabular">
                    {formatMoney(snapshot.autoApproveLimitMinor, expense.currency)}
                  </span>
                </Row>
                <Row label="Frequency rule">
                  <span className="tabular">
                    {snapshot.frequencyMaxCount} expenses per {snapshot.frequencyWindowMinutes}{' '}
                    minutes
                  </span>
                </Row>
                <Row label="Blocked categories">
                  {snapshot.blockedCategories.length > 0
                    ? snapshot.blockedCategories.join(', ')
                    : 'None'}
                </Row>
              </dl>
            ) : (
              <p className="px-5 py-4 text-sm text-text-secondary">
                The recorded policy snapshot is not in a shape this version of the dashboard can
                display. The decision and the reasons above are unaffected.
              </p>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Review" />
            <dl className="text-sm">
              <Row label="Opened">{formatDateTime(review.createdAt)}</Row>
              {review.resolution ? (
                <>
                  <Row label="Decided by">{review.resolution.resolvedBy.displayName}</Row>
                  <Row label="Decided">{formatDateTime(review.resolution.resolvedAt)}</Row>
                </>
              ) : (
                <Row label="Status">
                  <span className="text-text-secondary">Waiting for a decision</span>
                </Row>
              )}
            </dl>

            {review.state === 'RESOLVED' ? (
              <p className="border-t border-border px-5 py-3 text-xs text-pretty text-text-secondary">
                The policy said <strong className="text-text">reviewable</strong>; a manager then
                decided. Both facts are kept - neither replaces the other.
              </p>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Submission" />
            <dl className="text-sm">
              <Row label="Employee">
                <span className="font-mono text-xs">{expense.employeeId}</span>
              </Row>
              <Row label="Reference">
                <span className="font-mono text-xs">{expense.externalId}</span>
              </Row>
              <Row label="Spent">{formatDateTime(expense.spentAt)}</Row>
              <Row label="Received">{formatDateTime(review.receivedAt)}</Row>
            </dl>
            <p className="border-t border-border px-5 py-3 text-xs text-text-secondary">
              Times in {DISPLAY_TIME_ZONE_LABEL}.
            </p>
          </Card>

          <Link
            href={`/dashboard/expenses/${expense.id}`}
            className="text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
          >
            View this expense in the expense list →
          </Link>
        </div>
      </div>

      {query.isFetching && !query.isLoading ? (
        <div className="mt-4">
          <Alert tone="info">Refreshing…</Alert>
        </div>
      ) : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-right font-medium text-text">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the review">
      <Skeleton className="h-4 w-32" />
      <div className="mt-4 mb-6 flex flex-col gap-4 sm:flex-row sm:justify-between">
        <div className="flex-1">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="mt-2 h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-5 w-48" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-card border border-border bg-surface">
              <div className="border-b border-border px-5 py-4">
                <Skeleton className="h-4 w-44" />
              </div>
              <div className="flex flex-col gap-3 px-5 py-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="rounded-card border border-border bg-surface">
              <div className="border-b border-border px-5 py-4">
                <Skeleton className="h-4 w-28" />
              </div>
              <div className="flex flex-col gap-3 px-5 py-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
