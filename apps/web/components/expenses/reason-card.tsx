import { HelpCircle, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { presentReason } from '@/lib/expense-reasons';
import type { ExpenseReason } from '@/lib/expense-types';

/**
 * Why the policy reached its decision, in words and with the evidence.
 *
 * Every figure comes from the rule hit the policy engine RECORDED, never from
 * the company's current policy. The difference is invisible on screen and
 * total in meaning: reading the live policy would show the wrong limit beside
 * every expense submitted before the last policy edit, and nothing about the
 * page would look wrong.
 *
 * An unrecognised rule code renders too - with its raw code and whatever
 * scalar evidence it carries - rather than crashing the page or being dropped.
 * A rule added to the backend should degrade this page to "less explanation",
 * not to a blank screen (F06-T31).
 */
export function ReasonList({
  reasons,
  currency,
}: {
  reasons: readonly ExpenseReason[];
  currency: string;
}) {
  if (reasons.length === 0) {
    return (
      <p className="px-5 py-4 text-sm text-text-secondary">
        No policy rule fired for this expense. It was approved automatically.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {reasons.map((reason) => {
        const presented = presentReason(reason, currency);

        return (
          <li key={String(reason.code)} className="px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {presented.unknown ? (
                <HelpCircle className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
              ) : (
                <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
              )}

              <h3 className="text-sm font-semibold text-text">{presented.title}</h3>

              {/* What this INDIVIDUAL rule concluded, before precedence was
                  applied. An expense can carry one rule saying REVIEW and
                  another saying REJECT; showing only the final decision would
                  lose that. */}
              <Badge tone={reason.decision === 'REJECT' ? 'danger' : 'warning'}>
                {reason.decision === 'REJECT' ? 'Reject' : 'Review'}
              </Badge>

              <code className="ml-auto font-mono text-xs text-text-secondary">
                {String(reason.code)}
              </code>
            </div>

            <p className="mt-1.5 text-sm text-pretty text-text-secondary">
              {presented.explanation}
            </p>

            {presented.evidence.length > 0 ? (
              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
                {presented.evidence.map((item) => (
                  <div key={item.label}>
                    <dt className="text-xs text-text-secondary">{item.label}</dt>
                    <dd className="tabular mt-0.5 text-sm font-semibold text-text">
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
