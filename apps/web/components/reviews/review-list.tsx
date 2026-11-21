'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCheck, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, userMessage } from '@/lib/api-error';
import { formatDateTime, formatMoney, pluralise } from '@/lib/format';
import {
  fetchReviewPage,
  REVIEW_PAGE_SIZE,
  reviewKeys,
  type ReviewFilters,
} from '@/lib/review-queries';
import type { ReviewSummary } from '@/lib/review-types';
import { ReasonCodeChips } from './reason-code-chips';

const STATES = ['OPEN', 'RESOLVED', 'ALL'] as const;

/**
 * The review queue.
 *
 * Deliberately the SAME shape as the expense listing: a client component,
 * TanStack Query, keyset pagination, a cursor trail for "Newer", and the URL
 * as the single source of filter state. Two listings that behave differently
 * for no reason is how an application starts feeling like two applications.
 *
 * What is different is what it does NOT have. There is no search box and no
 * category filter, because `GET /v1/reviews` supports neither - and a control
 * that cannot do anything is worse than a missing one. The expense listing is
 * where searching lives, and the state filter here is the one the API
 * actually implements.
 */
export function ReviewList() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const filters = useMemo<ReviewFilters>(
    () => ({
      state:
        (STATES as readonly string[]).includes(searchParams.get('state') ?? '')
          ? (searchParams.get('state') as ReviewFilters['state'])
          : 'OPEN',
    }),
    [searchParams],
  );

  const cursor = searchParams.get('cursor');

  const [trail, setTrail] = useState<(string | null)[]>([]);
  const signature = filters.state;
  const lastSignature = useRef(signature);

  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setTrail([]);
    }
  }, [signature]);

  const write = useCallback(
    (state: ReviewFilters['state'], nextCursor: string | null) => {
      const params = new URLSearchParams();

      if (state !== 'OPEN') params.set('state', state);
      if (nextCursor) params.set('cursor', nextCursor);

      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const query = useQuery({
    queryKey: reviewKeys.list(filters, cursor),
    queryFn: ({ signal }) => fetchReviewPage(filters, cursor, signal),
    placeholderData: keepPreviousData,
  });

  const items = query.data?.items ?? [];
  const expired = query.error instanceof ApiError && query.error.status === 401;

  useEffect(() => {
    if (expired) {
      window.location.assign('/login?reason=expired');
    }
  }, [expired]);

  return (
    <>
      <div className="mb-4 max-w-xs">
        <Select
          label="Show"
          value={filters.state}
          // Changing the filter drops the cursor, for the same reason it does
          // on the expense listing: a cursor means "continue under THESE
          // filters", and carrying it continues a list that no longer exists.
          onChange={(value) => {
            setTrail([]);
            write(value as ReviewFilters['state'], null);
          }}
          options={[
            { value: 'OPEN', label: 'Waiting for a decision' },
            { value: 'RESOLVED', label: 'Already decided' },
            { value: 'ALL', label: 'All reviews' },
          ]}
        />
      </div>

      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <div
          aria-hidden="true"
          className={`h-0.5 transition-opacity duration-150 ${
            query.isFetching && !query.isLoading
              ? 'animate-pulse bg-accent opacity-100'
              : 'opacity-0'
          }`}
        />

        <div aria-live="polite" className="sr-only">
          {query.isLoading
            ? 'Loading reviews'
            : query.isError
              ? 'Could not load reviews'
              : `${pluralise(items.length, 'review')} shown`}
        </div>

        {query.isLoading ? (
          <LoadingRows />
        ) : query.isError && !expired ? (
          <EmptyState
            Icon={AlertCircle}
            tone="danger"
            title="Could not load reviews"
            description={userMessage(query.error)}
            action={
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : items.length === 0 ? (
          filters.state === 'OPEN' ? (
            <EmptyState
              Icon={CheckCheck}
              title="Nothing waiting for a decision"
              description="Every expense the policy flagged has been decided. New ones appear here as soon as they are submitted."
              action={
                <Button variant="secondary" onClick={() => write('ALL', null)}>
                  Show all reviews
                </Button>
              }
            />
          ) : (
            <EmptyState
              Icon={Inbox}
              title="No reviews to show"
              description="No expense has been flagged for human review yet."
            />
          )
        ) : (
          <ul key={cursor ?? 'first'} className="anim-enter divide-y divide-border">
            {items.map((review) => (
              <ReviewRow key={review.id} review={review} />
            ))}
          </ul>
        )}

        {items.length > 0 ? (
          <nav
            aria-label="Review pages"
            className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center"
          >
            <p className="text-sm text-text-secondary">
              {pluralise(items.length, 'review')} on page {trail.length + 1}
            </p>

            <div className="flex gap-2 sm:ml-auto">
              <Button
                variant="secondary"
                size="sm"
                disabled={cursor === null || query.isFetching}
                onClick={() =>
                  setTrail((previous) => {
                    const next = [...previous];
                    write(filters.state, next.pop() ?? null);

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
                    write(filters.state, next);
                  }
                }}
              >
                Older
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        ) : null}
      </div>
    </>
  );
}

/**
 * One review.
 *
 * A card rather than a table row at every width. Unlike the expense listing,
 * a review carries a variable-length list of reasons, and the thing a manager
 * is deciding on is "what is this and why was it flagged" rather than a
 * column they scan. A row would have to truncate the reasons to the point of
 * uselessness.
 */
function ReviewRow({ review }: { review: ReviewSummary }) {
  const { expense } = review;

  return (
    <li className="relative">
      <Link
        href={`/dashboard/reviews/${review.id}`}
        className="flex flex-col gap-2 px-4 py-4 transition-colors duration-150 hover:bg-surface-subtle sm:px-5"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate font-medium text-text">{expense.merchant}</span>
          <span className="tabular shrink-0 font-semibold whitespace-nowrap">
            {formatMoney(expense.amountMinor, expense.currency)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
          <span className="min-w-0 truncate font-mono">{expense.externalId}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono">{expense.employeeId}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{expense.category}</span>
          <span aria-hidden="true">·</span>
          <span className="whitespace-nowrap">{formatDateTime(expense.spentAt)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <ReasonCodeChips codes={review.reasonCodes} />

          {review.resolution ? (
            <span className="ml-auto text-xs text-text-secondary">
              {review.resolution.outcome === 'APPROVED' ? 'Approved' : 'Rejected'} by{' '}
              {review.resolution.resolvedBy.displayName}
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: Math.min(REVIEW_PAGE_SIZE, 6) }, (_, index) => (
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
  );
}
