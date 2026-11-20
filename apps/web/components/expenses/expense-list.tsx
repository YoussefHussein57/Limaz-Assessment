'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ChevronRight, FileSearch, Inbox } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useExpenseFilters } from '@/hooks/use-expense-filters';
import { ApiError, userMessage } from '@/lib/api-error';
import {
  dashboardKeys,
  expenseKeys,
  fetchExpenseCategories,
  fetchExpensePage,
  hasActiveFilters,
  PAGE_SIZE,
} from '@/lib/queries';
import { pluralise } from '@/lib/format';
import { ExpenseFiltersBar } from './expense-filters-bar';
import { ExpenseRows } from './expense-rows';

/**
 * The expense listing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE PAGE IS A CLIENT COMPONENT
 * ---------------------------------------------------------------------------
 *
 * It is the only surface in F06 whose request changes under the user's
 * fingers. The overview and the expense detail take their parameters from the
 * URL and are Server Components with no client fetching at all.
 *
 * Three things follow from TanStack Query owning this fetch, and all three
 * would otherwise be hand-written:
 *
 *   1. A RESPONSE CANNOT OVERWRITE A NEWER ONE. The filters are part of the
 *      query key, so the answer to `q=cas` is written into the `q=cas` entry
 *      and nowhere else. This is not a race being handled - the two results
 *      have no shared slot to collide in.
 *   2. `keepPreviousData` holds the previous page on screen while the next
 *      one loads, so paging does not blank the table and reflow the page.
 *   3. The AbortSignal is threaded into `fetch`, so a superseded request is
 *      actually cancelled rather than left running.
 *
 * ---------------------------------------------------------------------------
 * KEYSET PAGINATION, AND THE HONEST LIMITATION
 * ---------------------------------------------------------------------------
 *
 * The API returns a forward cursor only - there is no "previous" cursor,
 * because a keyset is a position in one direction. So the cursors already
 * visited are kept in a stack here and "Newer" pops it.
 *
 * The limitation that follows is real and is documented rather than hidden:
 * a link PASTED with a `cursor` in it starts with an empty stack, so "Newer"
 * from that page returns to the first page rather than to the page before it.
 * The alternative - encoding the whole trail in the URL - makes shared links
 * unwieldy to pay for a case that only arises when somebody shares a deep
 * page.
 */
export function ExpenseList() {
  const { filters, cursor, setFilters, setCursor, clear } = useExpenseFilters();

  // The trail of cursors already visited. Reset whenever the filters change,
  // because a cursor only means anything under the filters it was issued for.
  const [trail, setTrail] = useState<(string | null)[]>([]);
  const filterSignature = JSON.stringify(filters);
  const lastSignature = useRef(filterSignature);

  useEffect(() => {
    if (lastSignature.current !== filterSignature) {
      lastSignature.current = filterSignature;
      setTrail([]);
    }
  }, [filterSignature]);

  const query = useQuery({
    queryKey: expenseKeys.list(filters, cursor),
    queryFn: ({ signal }) => fetchExpensePage(filters, cursor, signal),
    // The previous page stays on screen while the next one is fetched. Without
    // it every page change blanks the table to a skeleton and the page height
    // jumps twice.
    placeholderData: keepPreviousData,
  });

  const goOlder = useCallback(() => {
    const next = query.data?.nextCursor;

    if (!next) {
      return;
    }

    setTrail((previous) => [...previous, cursor]);
    setCursor(next);
  }, [cursor, query.data?.nextCursor, setCursor]);

  const goNewer = useCallback(() => {
    setTrail((previous) => {
      const next = [...previous];
      // `pop` returns undefined on an empty stack - a deep link. `?? null`
      // sends the reader to the first page, which is a defined place to be.
      const target = next.pop() ?? null;

      setCursor(target);

      return next;
    });
  }, [setCursor]);

  /**
   * The company's WHOLE category vocabulary, from its own endpoint.
   *
   * F06 built this list from the page on screen. That looked harmless and was
   * not: a company whose rarer categories only appear on page three could not
   * select one from page one, and the control presented a partial list as the
   * complete set - a filter that silently offers a subset is harder to notice
   * than one that is missing (R-29).
   *
   * It is a separate query rather than part of the page response because the
   * answer does not change when the reader filters or pages. One fetch, then
   * ten minutes of cache.
   */
  const categoryQuery = useQuery({
    queryKey: dashboardKeys.expenseCategories(),
    queryFn: ({ signal }) => fetchExpenseCategories(signal),
    staleTime: 10 * 60_000,
  });

  const items = query.data?.items ?? [];
  const filtered = hasActiveFilters(filters);

  const categories = useMemo(() => {
    const known = new Set(categoryQuery.data?.categories ?? []);

    // A category chosen from a shared link stays selectable even if the server
    // list has not arrived yet, or no longer contains it. Without this the
    // control would silently reset the reader's filter.
    if (filters.category) {
      known.add(filters.category);
    }

    return [...known].sort();
  }, [categoryQuery.data, filters.category]);

  const canGoNewer = cursor !== null;
  const canGoOlder = Boolean(query.data?.nextCursor);

  // A session that expired mid-read: the reader is sent to sign in rather than
  // shown a retry button for something retrying cannot fix.
  const expired = query.error instanceof ApiError && query.error.status === 401;

  useEffect(() => {
    if (expired) {
      window.location.assign('/login?reason=expired');
    }
  }, [expired]);

  return (
    <>
      <ExpenseFiltersBar
        filters={filters}
        onChange={setFilters}
        onClear={clear}
        categories={categories}
        categoriesTruncated={categoryQuery.data?.truncated ?? false}
      />

      <div className="overflow-hidden rounded-card border border-border bg-surface">
        {/* A thin bar rather than a spinner over the content: a background
            refetch must not take the reader's place in the table, and
            replacing rows with a skeleton on every refresh would. */}
        <div
          aria-hidden="true"
          className={`h-0.5 transition-opacity duration-150 ${
            query.isFetching && !query.isLoading ? 'animate-pulse bg-accent opacity-100' : 'opacity-0'
          }`}
        />

        <div
          aria-busy={query.isLoading || undefined}
          aria-live="polite"
          // Announced once per settled state, not per row. A live region that
          // fires on every keystroke is noise a screen-reader user cannot
          // escape.
          className="sr-only"
        >
          {query.isLoading
            ? 'Loading expenses'
            : query.isError
              ? 'Could not load expenses'
              : `${pluralise(items.length, 'expense')} shown`}
        </div>

        {query.isLoading ? (
          <LoadingRows />
        ) : query.isError && !expired ? (
          <EmptyState
            Icon={AlertCircle}
            tone="danger"
            title="Could not load expenses"
            description={userMessage(query.error)}
            action={
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState
              Icon={FileSearch}
              title="No expenses match these filters"
              description="Nothing in this company's expenses matches every filter at once. Widen or clear them to see more."
              action={
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              Icon={Inbox}
              title="No expenses yet"
              description="Expenses appear here as soon as your integration submits them to the API. Nothing is wrong - there is simply nothing to show."
            />
          )
        ) : (
          <div key={cursor ?? 'first'} className="anim-enter">
            <ExpenseRows items={items} />
          </div>
        )}

        {items.length > 0 ? (
          <nav
            aria-label="Expense pages"
            // Stacked below `sm`: at 360px the count and two buttons on one
            // row squeeze the labels into two lines each. The buttons keep
            // their 44px touch target either way.
            className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center"
          >
            <p className="text-sm text-text-secondary">
              {pluralise(items.length, 'expense')} on page {trail.length + 1}
              {/* A page NUMBER, never a total. A keyset cursor does not know
                  how many pages exist and counting them would need a second
                  query whose answer changes between the two - which is
                  precisely the inconsistency keyset pagination avoids. */}
            </p>

            <div className="flex gap-2 sm:ml-auto">
              {/*
                The label tells the truth about where the button goes.

                A keyset cursor is a position in ONE direction, so "previous
                page" only exists for pages this session actually walked - they
                are in `trail`. Arriving on a pasted link with a cursor in it
                means there is no previous page to return to, and the button
                goes to the first page instead. Calling it "Newer" there would
                be a small lie the reader only discovers by pressing it (R-28).
              */}
              <Button
                variant="secondary"
                size="sm"
                onClick={goNewer}
                disabled={!canGoNewer || query.isFetching}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                {trail.length > 0 ? 'Newer' : 'First page'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={goOlder}
                disabled={!canGoOlder || query.isFetching}
              >
                Older
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        ) : null}
      </div>

      {query.isError && !expired ? (
        <div className="mt-4">
          <Alert tone="danger" title="Nothing was changed">
            This page only reads. A failed load cannot have affected any expense.
          </Alert>
        </div>
      ) : null}
    </>
  );
}

/**
 * Skeleton rows at the real row height.
 *
 * The count matches the page size, so the container is the height it will be
 * once the data lands and nothing below it moves. A shorter skeleton is worse
 * than none - it guarantees a jump.
 */
function LoadingRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: Math.min(PAGE_SIZE, 8) }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="hidden h-4 w-20 sm:block" />
          <Skeleton className="ml-auto h-4 w-24" />
          <Skeleton className="hidden h-5 w-24 rounded-full md:block" />
        </div>
      ))}
    </div>
  );
}
