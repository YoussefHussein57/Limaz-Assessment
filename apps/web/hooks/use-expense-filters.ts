'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { EMPTY_FILTERS, type ExpenseFilters } from '@/lib/queries';
import type { ExpenseDecision, ExpenseStatus } from '@/lib/expense-types';

/**
 * Filter state, with the URL as the ONE source of truth.
 *
 * ---------------------------------------------------------------------------
 * WHY THE URL AND NOT useState
 * ---------------------------------------------------------------------------
 *
 * Three things fall out of it, and none of them needs code:
 *
 *   - a filtered view is a link. "Here are the three expenses waiting on you"
 *     is a URL a manager can paste to a colleague.
 *   - the browser's back button works, because each filter change is a history
 *     entry.
 *   - reload keeps what you were looking at.
 *
 * And one thing is PREVENTED: a second copy of the same state. Keeping both a
 * `useState` and a query parameter means two values that must be kept equal,
 * and every bug in that class looks the same - the input shows one thing and
 * the results show another.
 *
 * The one deliberate exception is the search BOX, which holds its own text
 * while the user types and pushes to the URL on a debounce. That is a
 * different fact ("what is in the box right now") from the one this hook owns
 * ("what the list is filtered by"), and conflating them is what makes a
 * debounced input jump the cursor to the end mid-word.
 *
 * ---------------------------------------------------------------------------
 * WHY CHANGING A FILTER DROPS THE CURSOR
 * ---------------------------------------------------------------------------
 *
 * A cursor means "continue after this row under THIS ordering and THESE
 * filters". Carrying it across a filter change would ask the server to
 * continue a list that no longer exists: the reader would land in the middle
 * of a result set whose beginning they never saw, with no way to tell. So
 * every filter mutation here omits it (F06-T26).
 */

const STATUSES = ['APPROVED', 'REJECTED', 'PENDING_REVIEW'] as const;
const DECISIONS = ['APPROVE', 'REVIEW', 'REJECT'] as const;

export interface ExpenseFilterState {
  readonly filters: ExpenseFilters;
  readonly cursor: string | null;
  /** Merge a change into the filters. Always resets pagination. */
  readonly setFilters: (patch: Partial<ExpenseFilters>) => void;
  /** Move to another page, keeping the filters. */
  readonly setCursor: (cursor: string | null) => void;
  /** Back to an unfiltered first page. */
  readonly clear: () => void;
}

export function useExpenseFilters(): ExpenseFilterState {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const filters = useMemo<ExpenseFilters>(
    () => ({
      q: searchParams.get('q') ?? '',
      // An unrecognised value in the URL falls back to ALL rather than being
      // forwarded to the API, which would answer 400 and show the reader an
      // error for a link somebody mistyped.
      status: oneOf(searchParams.get('status'), STATUSES) ?? 'ALL',
      decision: oneOf(searchParams.get('decision'), DECISIONS) ?? 'ALL',
      category: searchParams.get('category') ?? '',
    }),
    [searchParams],
  );

  const cursor = searchParams.get('cursor');

  const write = useCallback(
    (next: ExpenseFilters, nextCursor: string | null) => {
      const params = new URLSearchParams();

      if (next.q) params.set('q', next.q);
      if (next.status !== 'ALL') params.set('status', next.status);
      if (next.decision !== 'ALL') params.set('decision', next.decision);
      if (next.category) params.set('category', next.category);
      if (nextCursor) params.set('cursor', nextCursor);

      const query = params.toString();

      // `replace`, not `push`, and `scroll: false`.
      //
      // Typing in the search box would otherwise add one history entry per
      // debounced keystroke, so one press of Back would move the reader one
      // letter rather than out of the search. Scroll is left alone because
      // jumping to the top on every filter change loses the reader's place in
      // a long table.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const setFilters = useCallback(
    (patch: Partial<ExpenseFilters>) => {
      // The cursor is dropped, never carried. See the note above.
      write({ ...filters, ...patch }, null);
    },
    [filters, write],
  );

  const setCursor = useCallback(
    (next: string | null) => {
      write(filters, next);
    },
    [filters, write],
  );

  const clear = useCallback(() => {
    write(EMPTY_FILTERS, null);
  }, [write]);

  return { filters, cursor, setFilters, setCursor, clear };
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export type { ExpenseStatus, ExpenseDecision };
