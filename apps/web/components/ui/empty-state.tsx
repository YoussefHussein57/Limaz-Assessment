import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The "there is nothing here" block.
 *
 * It takes a title AND a description because the two empty states this feature
 * has are genuinely different situations and must not share wording:
 *
 *   "No expenses yet"        - the company has never submitted one. Nothing is
 *                              wrong; there is nothing to do but explain where
 *                              expenses come from.
 *   "No expenses match"      - there is data, these filters exclude all of it.
 *                              The useful action is to widen the filters, and
 *                              that action is handed to the reader rather than
 *                              described.
 *
 * Collapsing them into one message is the common version of this component and
 * it is the wrong one: it leaves a manager wondering whether their integration
 * is broken when they have in fact just filtered everything out.
 */
export function EmptyState({
  Icon,
  title,
  description,
  action,
  tone = 'neutral',
}: {
  Icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div
        className={cn(
          'mb-3 flex size-11 items-center justify-center rounded-card',
          tone === 'danger' ? 'bg-danger-bg text-danger' : 'bg-surface-subtle text-text-secondary',
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </div>

      <p className="text-sm font-semibold text-text">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-pretty text-text-secondary">{description}</p>

      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
