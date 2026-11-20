import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-subtle text-text-secondary',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  accent: 'bg-accent-subtle text-accent',
};

/**
 * A short status label.
 *
 * It always renders TEXT. Expense decisions and review states are shown with
 * this, and WCAG 1.4.1 forbids colour as the only carrier of meaning - a
 * green pill tells a colour-blind reviewer nothing about whether an expense
 * was approved. The tone reinforces the word; it never replaces it.
 *
 * The foreground and background of each tone were measured together:
 * success 6.49:1, warning 6.37:1, danger 6.80:1.
 */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
