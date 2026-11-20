import { cn } from '@/lib/cn';

/**
 * A busy indicator.
 *
 * `role="status"` with a visually hidden label, because a spinning shape
 * communicates nothing to a screen reader. `aria-hidden` on the graphic itself
 * so the shape is not announced twice.
 */
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center', className)}>
      <svg
        className="size-4 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path
          d="M22 12a10 10 0 0 1-10 10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
