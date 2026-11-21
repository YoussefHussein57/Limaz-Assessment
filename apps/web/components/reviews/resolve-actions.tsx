'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-error';
import { dashboardKeys, expenseKeys } from '@/lib/queries';
import { resolveReview, reviewKeys } from '@/lib/review-queries';
import type { ReviewDecision, ReviewDetail } from '@/lib/review-types';
import { formatMoney } from '@/lib/format';

/**
 * Approve or reject an open review.
 *
 * This is the only consequential mutation a manager can perform, and almost
 * everything here exists because of one fact: **two managers resolving the
 * same review is an expected case, not an error case**. F05's conditional
 * UPDATE guarantees exactly one transition; this component is what that
 * guarantee looks like to the person who lost.
 */
export function ResolveActions({ review }: { review: ReviewDetail }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState<ReviewDecision | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);

  /**
   * Everything a resolution changes, refreshed together.
   *
   * Called after a SUCCESS and after a CONFLICT, because both mean the
   * database moved: in the conflict case somebody else moved it, and this
   * reader's cached copy is just as stale either way.
   *
   * The two halves are both needed. `invalidateQueries` covers what TanStack
   * Query owns - the review queue and the expense listing. `router.refresh()`
   * covers what it does not: the dashboard summary and the expense detail are
   * Server Components, and no client cache knows they exist.
   */
  const reconcile = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
      queryClient.invalidateQueries({ queryKey: expenseKeys.all }),
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all }),
    ]);

    router.refresh();
  };

  const mutation = useMutation({
    mutationFn: (decision: ReviewDecision) => resolveReview(review.id, decision),

    // No `onMutate`, no optimistic write. See `resolveReview` - showing a
    // decision before the server committed it means showing a decision that
    // may never have happened, on a record a company audits.
    onSuccess: async () => {
      setConflict(null);
      setAmbiguous(false);
      await reconcile();
    },

    onError: async (error) => {
      if (error instanceof ApiError && error.isConflict) {
        // NOT a failure. Another manager resolved it first - exactly what
        // ADR-004 describes. Refresh so the page shows the real outcome and
        // its reviewer, then say so plainly.
        setConflict(error.message);
        await reconcile();

        return;
      }

      if (error instanceof ApiError && error.isAmbiguous) {
        // The connection died with the outcome UNKNOWN. The server may have
        // committed. Offering "try again" here is how a manager produces a
        // second, conflicting decision - so the page refreshes itself and
        // asks them to look at what the server now says.
        setAmbiguous(true);
        await reconcile();
      }
    },

    /**
     * Clear the per-button pending flag however the mutation ends.
     *
     * `pending` implies `disabled` in `Button`, so leaving it set after a
     * FAILED request leaves that button permanently disabled and permanently
     * announcing "Approving" - while the alert beside it tells the manager to
     * look at the outcome and decide again. On the success and conflict paths
     * the component swaps itself for the resolved alert, so nothing showed;
     * it was only the recoverable paths that were left dead, which is exactly
     * the case F07-F13 exists to cover (AI_LOG 46).
     */
    onSettled: () => {
      setPending(null);
    },

    // A 4xx will not become a 2xx by asking again, and this request is NOT
    // idempotent in the general case: a blind retry by a different manager,
    // or with a different decision, is a second attempt at a decision.
    retry: false,
  });

  // Already resolved - by this manager a moment ago, or by somebody else.
  if (review.state === 'RESOLVED' && review.resolution) {
    return (
      <div className="border-t border-border px-5 py-4">
        <Alert tone={review.resolution.outcome === 'APPROVED' ? 'success' : 'danger'}>
          <strong className="font-medium">
            {review.resolution.outcome === 'APPROVED' ? 'Approved' : 'Rejected'}
          </strong>{' '}
          by {review.resolution.resolvedBy.displayName}.{' '}
          {conflict
            ? 'They resolved it before your decision reached the server, so yours was not applied.'
            : 'This review is closed and cannot be resolved again.'}
        </Alert>
      </div>
    );
  }

  const busy = mutation.isPending;
  const amount = formatMoney(review.expense.amountMinor, review.expense.currency);

  return (
    <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
      {/*
        An ALWAYS-PRESENT polite live region, carrying the same sentence the
        panel shows visually.

        Without it the outcome of a failed resolution is silent to a screen
        reader: the warning tone carries no `role="alert"` by design (a live
        region that interrupts is the wrong tool for most of this interface),
        and once the request fails the buttons simply return to normal. The
        person who pressed "Yes, approve" would be told nothing at all.

        It is rendered empty from the start rather than appearing with its
        text, because a live region added at the same moment as its content is
        frequently not announced. `sr-only` keeps it out of the layout, so the
        visual panel below is unchanged. `polite`, not `assertive`: this
        follows an action the reader just took and need not interrupt.
        Found during the F07-F13 injection (AI_LOG 46).
      */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {ambiguous
          ? 'The result is not confirmed. The connection failed before the server answered, so this decision may or may not have been recorded. Check the outcome before deciding again.'
          : mutation.isError && !conflict
            ? 'Your decision could not be recorded. Nothing was changed.'
            : ''}
      </p>

      {ambiguous ? (
        <Alert tone="warning" title="The result is not confirmed">
          The connection failed before the server answered, so this decision may or may not have
          been recorded. The page has been refreshed - check the outcome above before deciding
          again.
        </Alert>
      ) : null}

      {mutation.isError && !conflict && !ambiguous ? (
        <Alert tone="danger" title="Could not record your decision">
          {mutation.error instanceof ApiError
            ? mutation.error.message
            : 'Something went wrong. Nothing was changed.'}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <ConfirmButton
          decision="APPROVE"
          merchant={review.expense.merchant}
          amount={amount}
          busy={busy}
          pending={pending === 'APPROVE'}
          onConfirm={() => {
            setPending('APPROVE');
            mutation.mutate('APPROVE');
          }}
        />
        <ConfirmButton
          decision="REJECT"
          merchant={review.expense.merchant}
          amount={amount}
          busy={busy}
          pending={pending === 'REJECT'}
          onConfirm={() => {
            setPending('REJECT');
            mutation.mutate('REJECT');
          }}
        />
      </div>

      <p className="text-xs text-text-secondary">
        Your name and the time are recorded with the decision. It cannot be changed afterwards.
      </p>
    </div>
  );
}

/**
 * One action, behind a confirmation.
 *
 * ---------------------------------------------------------------------------
 * WHY A DIALOG AND NOT A BARE BUTTON
 * ---------------------------------------------------------------------------
 *
 * The action is irreversible by design - there is no "unresolve" endpoint and
 * the database constrains a review to one transition. A single misplaced
 * click would approve company spending permanently, and the person who did it
 * has no way back. The dialog states the merchant and the amount, so the
 * confirmation is about THIS expense rather than a generic "are you sure".
 *
 * Radix Dialog, already a dependency, because an accessible confirmation has
 * to trap focus, return it on close, close on Escape and mark the rest of the
 * page inert - all of which are easy to get subtly wrong by hand.
 *
 * `busy` disables BOTH buttons while either request is in flight, so a double
 * click cannot produce a second mutation and an impatient manager cannot
 * approve and then reject.
 */
function ConfirmButton({
  decision,
  merchant,
  amount,
  busy,
  pending,
  onConfirm,
}: {
  decision: ReviewDecision;
  merchant: string;
  amount: string;
  busy: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const approving = decision === 'APPROVE';

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Dialog.Trigger asChild>
        <Button
          variant={approving ? 'primary' : 'danger'}
          disabled={busy}
          pending={pending}
          pendingLabel={approving ? 'Approving' : 'Rejecting'}
          className="flex-1"
        >
          {!pending &&
            (approving ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <X className="size-4" aria-hidden="true" />
            ))}
          {approving ? 'Approve expense' : 'Reject expense'}
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-text/40" />
        <Dialog.Content className="anim-pop fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5">
          <div className="flex gap-3">
            <div
              className={`flex size-9 shrink-0 items-center justify-center rounded-control ${
                approving ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'
              }`}
            >
              {approving ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <AlertTriangle className="size-4" aria-hidden="true" />
              )}
            </div>

            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-text">
                {approving ? 'Approve this expense?' : 'Reject this expense?'}
              </Dialog.Title>

              {/* The merchant and the amount, so the confirmation is about
                  THIS expense. "Are you sure?" on its own tells a tired
                  reader nothing and trains them to click through. */}
              <Dialog.Description className="mt-1 text-sm text-pretty text-text-secondary">
                <span className="font-medium text-text">{amount}</span> at{' '}
                <span className="font-medium text-text">{merchant}</span> will be marked{' '}
                {approving ? 'approved' : 'rejected'}. Your name and the time are recorded, and
                the decision cannot be changed afterwards.
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button
              variant={approving ? 'primary' : 'danger'}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {approving ? 'Yes, approve' : 'Yes, reject'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
