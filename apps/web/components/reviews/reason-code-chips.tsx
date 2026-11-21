import { Badge } from '@/components/ui/badge';
import type { RuleCode } from '@/lib/expense-types';

/**
 * The reason codes on a queue row, as short readable chips.
 *
 * The list endpoint returns CODES only - the evidence comes with the detail
 * route. So this turns `AMOUNT_LIMIT` into "Over the limit": a manager
 * scanning a queue needs to know which kind of problem each row is, and
 * `BLOCKED_CATEGORY` in screaming snake case is a database value, not a
 * sentence.
 *
 * An unrecognised code still renders, humanised from its own name. A rule
 * added to the backend should make this list less polished, never blank
 * (the same contract as `expense-reasons.ts`).
 */
const LABELS: Record<string, string> = {
  AMOUNT_LIMIT: 'Over the limit',
  FREQUENCY: 'Too frequent',
  BLOCKED_CATEGORY: 'Blocked category',
};

export function ReasonCodeChips({ codes }: { codes: readonly RuleCode[] }) {
  if (codes.length === 0) {
    // Should not happen - a review exists because a rule fired - but a row
    // that renders nothing is better than a row that throws.
    return <Badge tone="neutral">Flagged for review</Badge>;
  }

  return (
    <>
      {codes.map((code) => (
        <Badge key={String(code)} tone="warning">
          {LABELS[String(code)] ?? humanise(String(code))}
        </Badge>
      ))}
    </>
  );
}

/** `MERCHANT_BLOCKLIST` -> `Merchant blocklist`. */
function humanise(code: string): string {
  const spaced = code.replace(/_/gu, ' ').toLowerCase();

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
