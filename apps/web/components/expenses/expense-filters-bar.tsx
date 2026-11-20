'use client';

import { FilterX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { hasActiveFilters, type ExpenseFilters } from '@/lib/queries';

/**
 * The filter bar.
 *
 * Four controls, and each one answers a question a manager actually has:
 *
 *   search    - "where is the expense for exp-1042"
 *   status    - "what is still waiting on me"
 *   decision  - "what did the policy flag" - NOT the same question. An expense
 *               the policy flagged and a manager approved is in `decision`
 *               but not in `status=PENDING_REVIEW`, and being able to ask both
 *               is the only way to see that distinction in the data.
 *   category  - "how much goes to equipment"
 *
 * A DATE RANGE is deliberately absent. It is optional in the brief and it
 * would widen the cursor contract - a range bound interacts with the `spentAt`
 * ordering - to answer a question no requirement asks. Recorded as an omission
 * rather than quietly skipped.
 *
 * Every control writes to the URL, which is the single source of truth. None
 * of them holds a copy of the filter state; the search box holds its own TEXT
 * for the length of its debounce, which is a different fact.
 */
export function ExpenseFiltersBar({
  filters,
  onChange,
  onClear,
  categories,
  categoriesTruncated,
}: {
  filters: ExpenseFilters;
  onChange: (patch: Partial<ExpenseFilters>) => void;
  onClear: () => void;
  /**
   * Every category this company has used, from its own endpoint - NOT the
   * ones visible on the current page. The difference matters: the page-derived
   * version presented a partial list as the complete set (R-29).
   */
  categories: readonly string[];
  /** The server capped the list. Say so rather than implying completeness. */
  categoriesTruncated: boolean;
}) {
  const active = hasActiveFilters(filters);

  return (
    <section aria-label="Filter expenses" className="mb-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end">
        <SearchInput
          label="Search"
          placeholder="Merchant, reference or employee"
          value={filters.q}
          onChange={(q) => onChange({ q })}
        />

        <Select
          label="Status"
          value={filters.status}
          onChange={(value) => onChange({ status: value as ExpenseFilters['status'] })}
          options={[
            { value: 'ALL', label: 'Any status' },
            { value: 'PENDING_REVIEW', label: 'Pending review' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'REJECTED', label: 'Rejected' },
          ]}
        />

        <Select
          label="Policy decision"
          value={filters.decision}
          onChange={(value) => onChange({ decision: value as ExpenseFilters['decision'] })}
          options={[
            { value: 'ALL', label: 'Any decision' },
            { value: 'APPROVE', label: 'Auto-approved' },
            { value: 'REVIEW', label: 'Flagged for review' },
            { value: 'REJECT', label: 'Auto-rejected' },
          ]}
        />

        <Select
          label="Category"
          value={filters.category}
          onChange={(category) => onChange({ category })}
          options={[
            { value: '', label: 'Any category' },
            ...categories.map((category) => ({ value: category, label: category })),
          ]}
        />

        {/* Only rendered when there is something to clear. A permanently
            visible "Clear" on an unfiltered list is a control that does
            nothing, which the brief rules out explicitly. */}
        {active ? (
          <Button variant="secondary" onClick={onClear} className="lg:h-11">
            <FilterX className="size-4" aria-hidden="true" />
            Clear filters
          </Button>
        ) : null}
      </div>

      {/*
        Only when it actually happened. A company with a normal expense
        vocabulary never sees this line - and one that does gets told the list
        is incomplete instead of being left to assume it is not.
      */}
      {categoriesTruncated ? (
        <p className="text-xs text-text-secondary">
          Only the first {categories.length} categories are listed. Search by merchant or
          reference to reach an expense in a category that is not shown.
        </p>
      ) : null}
    </section>
  );
}
