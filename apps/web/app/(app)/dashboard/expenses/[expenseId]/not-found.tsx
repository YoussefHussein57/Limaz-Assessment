import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * The expense is not there - or it is another company's.
 *
 * Those two cases are DELIBERATELY indistinguishable, and the wording says so
 * without apologising for it. The API answers 404 for both (ADR-003) because a
 * 403 would confirm the row exists, which turns the URL into a way to count a
 * competitor's expenses by walking ids.
 *
 * So the page cannot say which it was, and does not pretend to.
 */
export default function ExpenseNotFound() {
  return (
    <div className="rounded-card border border-border bg-surface">
      <EmptyState
        Icon={FileQuestion}
        title="That expense is not here"
        description="It does not exist, or it belongs to another company. The dashboard only ever shows your own company's expenses."
        action={
          <Link
            href="/dashboard/expenses"
            className="inline-flex h-11 items-center rounded-control border border-border-input bg-surface px-4 text-sm font-medium text-text transition-colors duration-150 hover:bg-surface-subtle"
          >
            Back to expenses
          </Link>
        }
      />
    </div>
  );
}
