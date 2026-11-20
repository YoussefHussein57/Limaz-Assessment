'use client';

import { AlertCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/page-header';

/**
 * The overview failed to render.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT SHOWN
 * ---------------------------------------------------------------------------
 *
 * Not `error.message`. In production Next already replaces a server error's
 * message with a generic one, but this boundary also catches client errors,
 * where the message can be anything - including a database error that leaked
 * through an upstream it should not have. A fixed sentence is the only version
 * that cannot surface internals, and a reader cannot act on a stack trace
 * anyway.
 *
 * `digest` IS shown. It is a server-generated hash that appears in the logs
 * too, so a person reporting a problem can quote something that identifies
 * their failure without revealing anything about it.
 *
 * `reset()` re-renders the segment. It is the right retry here because the
 * page only READS - there is no partially applied change to worry about, which
 * is why that is said out loud rather than left for the reader to wonder
 * about.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const retry = useRetry(reset);

  useEffect(() => {
    // The platform collects this; the page does not display it.
    console.error('Dashboard failed to render', error);
  }, [error]);

  return (
    <>
      <PageHeader title="Overview" />

      <div className="rounded-card border border-border bg-surface">
        <EmptyState
          Icon={AlertCircle}
          tone="danger"
          title="Could not load the overview"
          description="The server did not answer. Nothing was changed - this page only reads."
          action={
            <div className="flex flex-col items-center gap-3">
              <Button onClick={retry}>Try again</Button>
              {error.digest ? (
                <p className="font-mono text-xs text-text-secondary">
                  Reference: {error.digest}
                </p>
              ) : null}
            </div>
          }
        />
      </div>
    </>
  );
}

/**
 * WHY RETRY IS A FULL RELOAD AND NOT `reset()`.
 *
 * Two mechanisms were tried against a real failure - the API container stopped,
 * then started again - and neither recovered:
 *
 *   1. `reset()` alone. It re-renders this boundary's subtree on the CLIENT.
 *      Every page it protects is a Server Component, and the router still holds
 *      the failed RSC payload, so the same failure is produced again.
 *   2. `router.refresh()` then `reset()`. Still nothing, because the throw
 *      came from `(app)/layout.tsx`: when a LAYOUT fails there is no
 *      successfully rendered tree for the router to refresh into.
 *
 * So the button does what the situation actually requires: ask the server for
 * the document again. That is not a workaround - these pages are server
 * rendered, and every piece of state on them comes from one server render, so
 * "try again" and "fetch this page again" are the same operation.
 *
 * The cost is a full page load instead of a partial one. It is paid only on an
 * error path that is already a bad day, and it is the version that was
 * VERIFIED to work (F06-T35, AI_LOG 39).
 */
function useRetry(_reset: () => void): () => void {
  return () => {
    window.location.reload();
  };
}
