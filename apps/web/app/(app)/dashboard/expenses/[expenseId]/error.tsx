'use client';

import { AlertCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * The expense failed to load for a reason that is not "it is not there".
 *
 * A missing or foreign expense never reaches here - the page calls
 * `notFound()` for those, which renders `not-found.tsx` instead. So this
 * boundary is genuinely for the unexpected: the API unreachable, a 500, a
 * malformed response.
 *
 * `error.message` is not displayed, for the same reason as on the overview:
 * this boundary also catches client errors, where the message can carry
 * anything. The digest is shown so a report can be matched to a log line.
 */
export default function ExpenseDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Expense detail failed to render', error);
  }, [error]);

  return (
    <div className="rounded-card border border-border bg-surface">
      <EmptyState
        Icon={AlertCircle}
        tone="danger"
        title="Could not load this expense"
        description="The server did not answer. Nothing was changed - this page only reads."
        action={
          <div className="flex flex-col items-center gap-3">
            <Button onClick={reset}>Try again</Button>
            {error.digest ? (
              <p className="font-mono text-xs text-text-secondary">Reference: {error.digest}</p>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
