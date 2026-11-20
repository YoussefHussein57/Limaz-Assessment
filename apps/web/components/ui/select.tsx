'use client';

import { ChevronDown } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/cn';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A filter dropdown, built on the NATIVE `<select>`.
 *
 * Radix is already a dependency and has a Select, so this is a decision rather
 * than a shortcut. The native control wins here for reasons that matter on the
 * viewport sizes this feature is judged at:
 *
 *   - on a phone it opens the platform's own picker, which is a full-height
 *     wheel or list the user already knows how to operate. A custom popover
 *     at 360px is a scrolling panel that fights the keyboard and the
 *     address bar.
 *   - keyboard behaviour, type-ahead and screen-reader announcement are the
 *     platform's, so there is nothing to get subtly wrong.
 *   - zero additional JavaScript on a page that has a table to render.
 *
 * What it costs is control over the open menu's appearance. The closed
 * control - which is what is on screen 99% of the time - is styled with the
 * project's tokens, and that is the part that has to match.
 *
 * The chevron is `pointer-events-none` so a click anywhere, the icon included,
 * reaches the select underneath.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const id = useId();
  const active = options.find((option) => option.value === value);
  // "Any" is the first option everywhere, so a non-default selection is
  // exactly "not the first". Highlighting it is what makes an applied filter
  // visible without reading every control.
  const isDefault = options[0]?.value === value;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {/* A visible label, not a placeholder. A control whose only label is its
          current value stops saying what it filters the moment it is used. */}
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>

      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            'h-11 w-full appearance-none rounded-control border bg-surface',
            'pr-9 pl-3 text-sm text-text',
            'transition-colors duration-150',
            isDefault
              ? 'border-border-input hover:border-text-secondary'
              : 'border-accent bg-accent-subtle font-medium text-accent',
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <ChevronDown
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2',
            isDefault ? 'text-text-secondary' : 'text-accent',
          )}
        />
      </div>

      {/* Announced to a screen reader when the value changes, because a
          <select> change is otherwise silent once focus moves on. */}
      <span className="sr-only" aria-live="polite">
        {label}: {active?.label ?? value}
      </span>
    </div>
  );
}
