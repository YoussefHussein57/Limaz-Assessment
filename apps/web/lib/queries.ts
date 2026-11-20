import { apiGet, queryString } from './api-client';
import type { ExpenseDecision, ExpensePage, ExpenseStatus } from './expense-types';

/**
 * Query keys and the functions that fill them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILTERS ARE PART OF THE KEY
 * ---------------------------------------------------------------------------
 *
 * The key IS the identity of the data. Two different filter sets are two
 * different lists, and giving them one key would mean:
 *
 *   - a response for `q=cas` could be written into the cache and rendered as
 *     the answer for `q=casino`. That is F06-T38's stale-response race, and
 *     with the filters in the key it does not exist - not because a race is
 *     handled, but because the two results have nowhere to collide.
 *   - going back to a previous filter would refetch instead of showing the
 *     result instantly from cache.
 *
 * The cursor is in the key for the same reason: page 2 is not page 1.
 *
 * ---------------------------------------------------------------------------
 * THE INVALIDATION CONTRACT FOR F07
 * ---------------------------------------------------------------------------
 *
 * The keys are PREFIXED so one call can invalidate a whole family. After a
 * review is resolved in F07:
 *
 *   invalidateQueries({ queryKey: expenseKeys.lists() })   every filter set
 *   invalidateQueries({ queryKey: expenseKeys.detail(id) })
 *   router.refresh()                                       the Server Components
 *
 * `lists()` without the filters matches every list query by prefix, which is
 * why the filters are the LAST element rather than baked into the first.
 */

export interface ExpenseFilters {
  q: string;
  status: ExpenseStatus | 'ALL';
  decision: ExpenseDecision | 'ALL';
  category: string;
}

export const EMPTY_FILTERS: ExpenseFilters = {
  q: '',
  status: 'ALL',
  decision: 'ALL',
  category: '',
};

export const expenseKeys = {
  all: ['expenses'] as const,
  lists: () => [...expenseKeys.all, 'list'] as const,
  list: (filters: ExpenseFilters, cursor: string | null) =>
    [...expenseKeys.lists(), filters, cursor] as const,
  details: () => [...expenseKeys.all, 'detail'] as const,
  detail: (id: string) => [...expenseKeys.details(), id] as const,
};

export const dashboardKeys = {
  all: ['dashboard'] as const,
  summary: () => [...dashboardKeys.all, 'summary'] as const,
};

/** The page size the listing requests. Bounded by the API at 100. */
export const PAGE_SIZE = 25;

export async function fetchExpensePage(
  filters: ExpenseFilters,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ExpensePage> {
  const search = queryString({
    q: filters.q || undefined,
    status: filters.status === 'ALL' ? undefined : filters.status,
    decision: filters.decision === 'ALL' ? undefined : filters.decision,
    category: filters.category || undefined,
    cursor: cursor ?? undefined,
    limit: PAGE_SIZE,
  });

  return apiGet<ExpensePage>(`/v1/expenses${search}`, signal);
}

/** True when anything is narrowing the list - drives the "clear" affordance. */
export function hasActiveFilters(filters: ExpenseFilters): boolean {
  return (
    filters.q !== '' ||
    filters.status !== 'ALL' ||
    filters.decision !== 'ALL' ||
    filters.category !== ''
  );
}
