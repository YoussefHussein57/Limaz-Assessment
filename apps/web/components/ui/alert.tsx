import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, { box: string; Icon: typeof Info }> = {
  info: { box: 'bg-accent-subtle text-accent border-accent/20', Icon: Info },
  success: { box: 'bg-success-bg text-success border-success/20', Icon: CheckCircle2 },
  warning: { box: 'bg-warning-bg text-warning border-warning/20', Icon: TriangleAlert },
  danger: { box: 'bg-danger-bg text-danger border-danger/20', Icon: AlertCircle },
};

/**
 * A block-level message.
 *
 * `role="alert"` for the danger tone only. A live region interrupts whatever a
 * screen reader is reading, which is right for "that login failed" and wrong
 * for a standing informational notice - overusing it trains people to ignore
 * it.
 *
 * Every tone carries an icon as well as a colour, so the meaning survives for
 * a reader who cannot distinguish the two backgrounds.
 */
export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const { box, Icon } = TONES[tone];

  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn('flex gap-3 rounded-card border p-3 text-sm', box)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        <div className={cn(title ? 'mt-0.5' : '', 'text-pretty')}>{children}</div>
      </div>
    </div>
  );
}
