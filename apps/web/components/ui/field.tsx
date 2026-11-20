'use client';

import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Shown under the field and announced when it appears. */
  error?: string | null;
  /** Static guidance, always present. */
  hint?: string;
  /** Rendered inside the field box, on the right - a show/hide toggle. */
  trailing?: ReactNode;
}

/**
 * A labelled text input.
 *
 * Label and input are bound by a generated id rather than nesting, so the
 * label stays clickable and screen readers announce the right name. `useId`
 * rather than a counter, because a counter produces different ids on the
 * server and the client and React rejects the mismatch.
 *
 * The error is wired three ways, because each one does a different job:
 *   aria-invalid    tells assistive tech the value is rejected
 *   aria-describedby points at the text explaining why
 *   role="alert"    makes that text announced when it appears, not only when
 *                   focus happens to land on the field
 *
 * The message is never colour alone - it carries words - because WCAG 1.4.1
 * forbids colour as the only carrier of meaning, and a red border tells a
 * colour-blind user nothing.
 */
export function Field({ label, error, hint, trailing, className, ...rest }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            'h-11 w-full rounded-control border bg-surface px-3 text-sm text-text',
            'placeholder:text-text-secondary',
            'transition-colors duration-150',
            // border-input, not border: a form control's boundary needs 3:1
            // contrast (WCAG 1.4.11). The decorative token measures 1.18:1.
            error ? 'border-danger' : 'border-border-input',
            trailing ? 'pr-11' : '',
            className,
          )}
          {...rest}
        />

        {trailing ? (
          <span className="absolute inset-y-0 right-0 flex items-center pr-1">{trailing}</span>
        ) : null}
      </div>

      {hint ? (
        <p id={hintId} className="text-xs text-text-secondary">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
