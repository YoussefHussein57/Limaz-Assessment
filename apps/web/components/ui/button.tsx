import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and blocks further clicks. */
  pending?: boolean;
  /** Announced in place of the label while pending. */
  pendingLabel?: string;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-text-inverse hover:bg-accent-hover',
  secondary: 'bg-surface text-text border border-border-input hover:bg-surface-subtle',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-subtle hover:text-text',
  danger: 'bg-danger text-text-inverse hover:brightness-110',
};

const SIZES: Record<Size, string> = {
  // 44px minimum on the primary size: WCAG 2.5.8 asks for 24px, but a 44px
  // target is what actually works under a thumb on a phone.
  md: 'h-11 px-4 text-sm',
  sm: 'h-9 px-3 text-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  pending = false,
  pendingLabel = 'Working',
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  // Pending implies disabled. Leaving a submit button live during an in-flight
  // request is how a double click becomes two logins (test F02.1-T05).
  const isBlocked = pending || disabled;

  return (
    <button
      type={type}
      disabled={isBlocked}
      // Tells assistive technology the control is working rather than broken.
      aria-busy={pending || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-control font-medium',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {pending && <Spinner label={pendingLabel} />}
      {children}
    </button>
  );
}
