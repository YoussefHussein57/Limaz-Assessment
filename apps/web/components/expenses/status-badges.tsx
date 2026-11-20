import { Badge } from '@/components/ui/badge';
import type {
  ExpenseDecision,
  ExpenseStatus,
  ReviewOutcome,
  ReviewState,
} from '@/lib/expense-types';

/**
 * The three things an expense can be labelled with, and why there are three.
 *
 * `decision` - what the POLICY concluded at submission. Never changes.
 * `status`   - the CURRENT outcome. A manager's resolution changes this.
 * review     - whether a human has looked, and what they said.
 *
 * They are shown together and they are allowed to disagree, because
 * "the policy flagged this and a manager approved it" is not a contradiction -
 * it is the most informative thing the system can say about that expense. Each
 * badge is therefore PREFIXED with what it is reporting; two bare pills
 * reading "Review" and "Approved" next to each other look like a bug.
 *
 * ---------------------------------------------------------------------------
 * COLOUR IS NEVER THE CARRIER
 * ---------------------------------------------------------------------------
 *
 * Every badge renders a word. WCAG 1.4.1 forbids colour as the only means of
 * conveying meaning, and a green pill tells a colour-blind reviewer nothing
 * about whether an expense was approved. The tone reinforces the word; it
 * never replaces it.
 */

const DECISION_LABEL: Record<ExpenseDecision, string> = {
  APPROVE: 'Approve',
  REVIEW: 'Review',
  REJECT: 'Reject',
};

const STATUS_LABEL: Record<ExpenseStatus, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PENDING_REVIEW: 'Pending review',
};

const STATUS_TONE = {
  APPROVED: 'success',
  REJECTED: 'danger',
  PENDING_REVIEW: 'warning',
} as const;

/**
 * What the policy said. Deliberately NEUTRAL in every case.
 *
 * Tinting it would put two coloured pills on every row competing for the
 * reader's eye, and the one that should win is the current status - that is
 * the fact a manager acts on. The original decision is context.
 */
export function DecisionBadge({ decision }: { decision: ExpenseDecision }) {
  return <Badge tone="neutral">Policy: {DECISION_LABEL[decision]}</Badge>;
}

/** Where the expense stands now. The coloured one. */
export function StatusBadge({ status }: { status: ExpenseStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** Only rendered when a review exists. */
export function ReviewBadge({
  state,
  outcome,
}: {
  state: ReviewState;
  outcome: ReviewOutcome | null;
}) {
  if (state === 'OPEN' || !outcome) {
    return <Badge tone="warning">Awaiting a manager</Badge>;
  }

  return (
    <Badge tone={outcome === 'APPROVED' ? 'success' : 'danger'}>
      {outcome === 'APPROVED' ? 'Approved by a manager' : 'Rejected by a manager'}
    </Badge>
  );
}

export { DECISION_LABEL, STATUS_LABEL };
