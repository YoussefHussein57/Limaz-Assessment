import { cn } from '@/lib/cn';

/**
 * A placeholder for content that has not arrived.
 *
 * `aria-hidden`: a screen reader gains nothing from a grey rectangle, and the
 * region it sits in should carry the `aria-busy` state instead.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-surface-subtle', className)}
    />
  );
}
