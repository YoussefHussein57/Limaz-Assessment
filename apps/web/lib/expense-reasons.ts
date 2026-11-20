import { formatMoney } from './format';
import type { ExpenseReason, RuleCode } from './expense-types';

/**
 * Turning a machine-readable rule hit into something a manager can read.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE COMES FROM THE RECORDED HIT, NOT FROM THE CURRENT POLICY
 * ---------------------------------------------------------------------------
 *
 * The limit shown next to an expense is the limit it was JUDGED against, read
 * from `detail` - which the policy engine wrote at submission time. Reading
 * the company's current policy instead would be quietly wrong for every
 * expense submitted before the last policy edit, and nothing would flag it:
 * the page would render, the number would look sensible, and it would be a
 * different number from the one that produced the decision.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY FIELD IS CHECKED AT RUNTIME
 * ---------------------------------------------------------------------------
 *
 * `detail` is a `Json` column. Its shape is a convention between two
 * deployments, not a compile-time guarantee, and a row written by an older
 * build is a real possibility. So each reader validates what it needs and
 * falls back rather than asserting - the alternative is `undefined` rendered
 * where a currency amount should be, or a thrown error that blanks the page.
 *
 * An UNKNOWN code is not an error either (F06-T31). It renders with its raw
 * code and whatever scalar fields its detail happens to carry, so a rule added
 * to the backend tomorrow degrades to "less explanation" instead of to a
 * broken page.
 */

export interface PresentedReason {
  readonly code: RuleCode;
  readonly decision: ExpenseReason['decision'];
  /** A short sentence a manager can act on. */
  readonly title: string;
  readonly explanation: string;
  /** Label/value pairs, already formatted. Possibly empty. */
  readonly evidence: readonly { readonly label: string; readonly value: string }[];
  /** True when the code was not recognised and the fallback was used. */
  readonly unknown: boolean;
}

export function presentReason(reason: ExpenseReason, currency: string): PresentedReason {
  const detail = asRecord(reason.detail);

  switch (reason.code) {
    case 'AMOUNT_LIMIT':
      return amountLimit(reason, detail, currency);
    case 'FREQUENCY':
      return frequency(reason, detail);
    case 'BLOCKED_CATEGORY':
      return blockedCategory(reason, detail);
    default:
      return unknownReason(reason, detail);
  }
}

function amountLimit(
  reason: ExpenseReason,
  detail: Record<string, unknown>,
  currency: string,
): PresentedReason {
  const amount = numberOrNull(detail.amountMinor);
  const limit = numberOrNull(detail.autoApproveLimitMinor);

  const evidence: { label: string; value: string }[] = [];

  if (amount !== null) {
    evidence.push({ label: 'Expense amount', value: formatMoney(amount, currency) });
  }

  if (limit !== null) {
    evidence.push({ label: 'Auto-approval limit', value: formatMoney(limit, currency) });
  }

  if (amount !== null && limit !== null) {
    // Integer arithmetic on minor units, then formatted. Subtracting the
    // DISPLAYED values would mean parsing two formatted strings back into
    // numbers, which is how a rounding error gets introduced into a figure
    // that was exact in the database.
    evidence.push({ label: 'Over by', value: formatMoney(amount - limit, currency) });
  }

  return {
    code: reason.code,
    decision: reason.decision,
    title: 'Over the auto-approval limit',
    explanation:
      'The amount was above the limit this company had configured at the moment the expense was submitted.',
    evidence,
    unknown: false,
  };
}

function frequency(reason: ExpenseReason, detail: Record<string, unknown>): PresentedReason {
  const count = numberOrNull(detail.countIncludingCurrent);
  const max = numberOrNull(detail.maxCount);
  const windowMinutes = numberOrNull(detail.windowMinutes);

  const evidence: { label: string; value: string }[] = [];

  if (count !== null) {
    // The name of the field matters to the reader: this count INCLUDES the
    // expense being looked at. Labelling it "previous expenses" would be off
    // by one and would look like a bug in the rule.
    evidence.push({ label: 'Expenses in the window', value: `${count} (including this one)` });
  }

  if (max !== null) {
    evidence.push({ label: 'Maximum allowed', value: String(max) });
  }

  if (windowMinutes !== null) {
    evidence.push({ label: 'Window', value: describeWindow(windowMinutes) });
  }

  return {
    code: reason.code,
    decision: reason.decision,
    title: 'Too many expenses in a short window',
    explanation:
      'This employee submitted more expenses within the configured window than the policy allows. The window is measured on when the money was spent, not on when it arrived.',
    evidence,
    unknown: false,
  };
}

function blockedCategory(reason: ExpenseReason, detail: Record<string, unknown>): PresentedReason {
  const category = typeof detail.category === 'string' ? detail.category : null;
  const blocked = Array.isArray(detail.blockedCategories)
    ? detail.blockedCategories.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const evidence: { label: string; value: string }[] = [];

  if (category !== null) {
    evidence.push({ label: 'Submitted category', value: category });
  }

  if (blocked.length > 0) {
    evidence.push({ label: 'Blocked at the time', value: blocked.join(', ') });
  }

  return {
    code: reason.code,
    decision: reason.decision,
    title: 'Category blocked by the company policy',
    explanation:
      'The category was on this company’s blocked list when the expense was submitted.',
    evidence,
    unknown: false,
  };
}

/**
 * A rule this build has never heard of.
 *
 * It still renders: the code, and whatever scalar fields the detail carries,
 * labelled from their own key names. Not pretty, and deliberately not a
 * `JSON.stringify` dump - a manager reading "maxCount: 3" learns something;
 * a wall of braces does not.
 */
function unknownReason(reason: ExpenseReason, detail: Record<string, unknown>): PresentedReason {
  const evidence = Object.entries(detail)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 6)
    .map(([key, value]) => ({ label: humanise(key), value: String(value) }));

  return {
    code: reason.code,
    decision: reason.decision,
    title: humanise(String(reason.code)),
    explanation:
      'This expense was flagged by a policy rule this version of the dashboard does not have a description for. The recorded evidence is shown as the policy engine wrote it.',
    evidence,
    unknown: true,
  };
}

/** `60` -> `60 minutes`, `120` -> `2 hours`. */
function describeWindow(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) {
    const hours = minutes / 60;

    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }

  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** `countIncludingCurrent` -> `Count including current`. */
function humanise(key: string): string {
  const spaced = key.replace(/_/gu, ' ').replace(/([a-z\d])([A-Z])/gu, '$1 $2');

  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
