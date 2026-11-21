import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { ReasonList } from '@/components/expenses/reason-card';
import { DecisionBadge, ReviewBadge, StatusBadge } from '@/components/expenses/status-badges';
import { Card, CardHeader } from '@/components/ui/card';
import { serverFetch } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { requireUser } from '@/lib/auth';
import { readPolicySnapshot, type ExpenseDetail } from '@/lib/expense-types';
import { DISPLAY_TIME_ZONE_LABEL, formatDateTime, formatMoney } from '@/lib/format';

/**
 * One expense, in full.
 *
 * ---------------------------------------------------------------------------
 * A ROUTE, NOT A DRAWER OR A DIALOG
 * ---------------------------------------------------------------------------
 *
 * All three were considered. A route wins on four counts that matter here:
 *
 *   - it has a URL, so "look at exp-1005" is a link a manager can send
 *   - the browser's back button does what it looks like it does
 *   - no focus trap to get wrong, and no scroll lock fighting a phone
 *   - F07 adds approve/reject controls here, and a dialog is the wrong place
 *     to make a decision that needs the policy evidence visible beside it
 *
 * A drawer would also have to be fed from a row already in memory, which means
 * a pasted link could not open one.
 *
 * ---------------------------------------------------------------------------
 * THREE FACTS, NONE OF WHICH REPLACES ANOTHER
 * ---------------------------------------------------------------------------
 *
 *   Policy decision : REVIEW    - what the engine concluded at submission
 *   Current status  : APPROVED  - where the expense stands now
 *   Human outcome   : Approved by a manager
 *
 * They are allowed to disagree and the page says why, because a reader seeing
 * "Review" and "Approved" side by side with no explanation reasonably concludes
 * something is broken.
 */
export const dynamic = 'force-dynamic';

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ expenseId: string }>;
}) {
  await requireUser();

  const { expenseId } = await params;

  let expense: ExpenseDetail;

  try {
    expense = await serverFetch<ExpenseDetail>(`/v1/expenses/${encodeURIComponent(expenseId)}`);
  } catch (error) {
    // 404 AND 400 both become the not-found page. The API answers 400 for an
    // id that is not a UUID - correct there, because the id is unusable rather
    // than absent - but to a person who followed a broken link the two are the
    // same experience, and an "invalid request" page would be about our
    // plumbing rather than about their problem.
    //
    // A 404 here is also what another company's expense returns (ADR-003), and
    // it is indistinguishable from a missing one on purpose.
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      notFound();
    }

    // Anything else is the error boundary's business.
    throw error;
  }

  const snapshot = readPolicySnapshot(expense.policySnapshot);

  return (
    <>
      <Link
        href="/dashboard/expenses"
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to expenses
      </Link>

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold break-words text-text sm:text-2xl">
            {expense.merchant}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
            <span className="font-mono text-xs">{expense.externalId}</span>
            <span aria-hidden="true">·</span>
            <span>{expense.category}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDateTime(expense.spentAt)}</span>
          </p>
        </div>

        <div className="shrink-0 sm:text-right">
          <p className="tabular text-2xl font-semibold tracking-tight text-text">
            {formatMoney(expense.amountMinor, expense.currency)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 sm:justify-end">
            <DecisionBadge decision={expense.decision} />
            <StatusBadge status={expense.status} />
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {/* The evidence column. First in the DOM as well as on screen, because
            "why was this flagged?" is the question that brings a manager
            here. */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader
              title="Why the policy decided this"
              description="Every rule that fired, with the evidence the engine recorded at the time."
            />
            <ReasonList reasons={expense.reasons} currency={expense.currency} />
          </Card>

          <Card>
            <CardHeader
              title="Policy in force when this was judged"
              description="A snapshot taken at submission. Editing the policy today does not change this expense."
            />

            {snapshot ? (
              <dl className="text-sm">
                <Row label="Auto-approval limit">
                  <span className="tabular">
                    {formatMoney(snapshot.autoApproveLimitMinor, expense.currency)}
                  </span>
                </Row>
                <Row label="Frequency rule">
                  <span className="tabular">
                    {snapshot.frequencyMaxCount} expenses per {snapshot.frequencyWindowMinutes}{' '}
                    minutes
                  </span>
                </Row>
                <Row label="Blocked categories">
                  {snapshot.blockedCategories.length > 0
                    ? snapshot.blockedCategories.join(', ')
                    : 'None'}
                </Row>
              </dl>
            ) : (
              // A snapshot written by an older build, or one whose shape this
              // version does not recognise. Saying so beats rendering
              // `undefined` where a limit should be.
              <p className="px-5 py-4 text-sm text-text-secondary">
                The recorded policy snapshot is not in a shape this version of the dashboard can
                display. The decision and the reasons above are unaffected.
              </p>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Human review" />

            {expense.review ? (
              <>
                <dl className="text-sm">
                  <Row label="Outcome">
                    <ReviewBadge state={expense.review.state} outcome={expense.review.outcome} />
                  </Row>
                  <Row label="Opened">{formatDateTime(expense.review.createdAt)}</Row>
                  {expense.review.resolvedBy ? (
                    <Row label="Reviewed by">{expense.review.resolvedBy.displayName}</Row>
                  ) : null}
                  {expense.review.resolvedAt ? (
                    <Row label="Resolved">{formatDateTime(expense.review.resolvedAt)}</Row>
                  ) : null}
                </dl>

                <p className="border-t border-border px-5 py-3 text-xs text-pretty text-text-secondary">
                  {expense.review.state === 'RESOLVED' ? (
                    <>
                      The policy said <strong className="text-text">reviewable</strong>; a manager
                      then decided. Both facts are kept - neither replaces the other.
                    </>
                  ) : (
                    <>
                      This expense is waiting for a decision.{' '}
                      <Link
                        href={`/dashboard/reviews/${expense.review.id}`}
                        className="font-medium text-accent underline underline-offset-2"
                      >
                        Open the review
                      </Link>{' '}
                      to approve or reject it.
                    </>
                  )}
                </p>
              </>
            ) : (
              // null, not an empty review. "There was never a review" and
              // "there is a review with nothing filled in" are different facts.
              <p className="px-5 py-4 text-sm text-text-secondary">
                No review was opened. The policy decided this expense on its own.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="Submission" />
            <dl className="text-sm">
              <Row label="Employee">
                <span className="font-mono text-xs">{expense.employeeId}</span>
              </Row>
              <Row label="Reference">
                <span className="font-mono text-xs">{expense.externalId}</span>
              </Row>
              <Row label="Amount">
                <span className="tabular">
                  {formatMoney(expense.amountMinor, expense.currency)}
                </span>
              </Row>
              <Row label="Spent">{formatDateTime(expense.spentAt)}</Row>
              <Row label="Received">{formatDateTime(expense.receivedAt)}</Row>
            </dl>
            <p className="border-t border-border px-5 py-3 text-xs text-text-secondary">
              Both times in {DISPLAY_TIME_ZONE_LABEL}. The gap between them is how long the
              expense took to reach us.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

/** One label/value pair inside a definition list. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-2.5 last:border-b-0">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-right font-medium text-text">{children}</dd>
    </div>
  );
}
