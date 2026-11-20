'use client';

import { AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * The ROOT error boundary.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAS TO EXIST, AND WHY THE PER-PAGE ONES ARE NOT ENOUGH
 * ---------------------------------------------------------------------------
 *
 * An `error.tsx` catches errors thrown by its segment's PAGE and anything
 * below it. It does **not** catch errors thrown by its own `layout.tsx` -
 * that layout is rendered by the parent, so a parent boundary has to catch it.
 *
 * `app/(app)/layout.tsx` calls `requireUser()`, which throws
 * `ApiUnreachableError` when the API cannot be reached at all. Before this
 * file existed, that throw had nothing above it: Next fell back to its own
 * bare "This page couldn't load" screen - no shell, no navigation, no way
 * back, and a 500. Found by stopping the API container and loading the
 * dashboard (F06-T35, AI_LOG 38).
 *
 * The distinction F02.1 built - "the backend is down" is NOT "you are signed
 * out" - was correct in the code and invisible on screen, because the screen
 * never rendered.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT USE THE APP SHELL
 * ---------------------------------------------------------------------------
 *
 * The shell needs a resolved user, and the most likely reason this boundary
 * is rendering is that resolving the user is exactly what failed. So it is
 * standalone and centred, in the same visual language as the sign-in page.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const retry = useRetry(reset);

  useEffect(() => {
    // The platform collects this. The page deliberately does not display it:
    // this boundary catches client errors too, where the message can contain
    // anything, and a reader cannot act on a stack trace.
    console.error('Unhandled application error', error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-6 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-card bg-warning-bg text-warning">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </div>

        <h1 className="text-lg font-semibold text-text">Could not reach the server</h1>

        <p className="mt-2 text-sm text-pretty text-text-secondary">
          The application is running but the service behind it did not answer. This is not a
          problem with your account, and nothing you were looking at has changed.
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          {/* `reset()` re-renders the segment. It is a safe retry because
              every page it protects only READS - there is no half-applied
              change to worry about. */}
          <Button onClick={retry}>Try again</Button>
          <Button variant="secondary" onClick={() => window.location.assign('/login')}>
            Go to sign in
          </Button>
        </div>

        {error.digest ? (
          <p className="mt-5 font-mono text-xs text-text-secondary">Reference: {error.digest}</p>
        ) : null}
      </div>
    </main>
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
