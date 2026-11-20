import Link from 'next/link';
import { cn } from '@/lib/cn';

/**
 * One summary figure.
 *
 * It is a LINK, to the expense list already filtered to what it counts. A
 * dashboard number a reader cannot get behind is a number they have to trust;
 * one that takes them to the rows is one they can check. That is also what
 * makes the pending-review figure useful without F07 existing yet - it leads
 * to the expenses themselves rather than to a resolve button that would do
 * nothing.
 *
 * The number is `tabular` so a column of cards lines up, and large enough to
 * be the first thing the eye lands on; the label above it is small and
 * secondary, which is the opposite of how a card reads if the label is given
 * equal weight.
 */
export function StatCard({
  label,
  value,
  note,
  href,
  tone = 'neutral',
}: {
  label: string;
  value: number | string;
  /** One line of context. Never a fabricated trend or percentage change. */
  note?: string;
  href: string;
  tone?: 'neutral' | 'warning';
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group block rounded-card border bg-surface p-4',
        'transition-colors duration-150',
        tone === 'warning'
          ? 'border-warning/30 hover:border-warning/60'
          : 'border-border hover:border-border-input',
      )}
    >
      <p className="text-xs font-medium text-text-secondary">{label}</p>

      <p className="tabular mt-2 text-3xl leading-none font-semibold tracking-tight text-text">
        {value}
      </p>

      {note ? (
        <p className={cn('mt-2 text-xs', tone === 'warning' ? 'text-warning' : 'text-text-secondary')}>
          {note}
        </p>
      ) : null}
    </Link>
  );
}
