'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * A debounced search box.
 *
 * ---------------------------------------------------------------------------
 * WHY IT HOLDS ITS OWN TEXT
 * ---------------------------------------------------------------------------
 *
 * The URL owns the filter; this box owns what is currently typed. They are
 * different facts and they are out of step on purpose, for the length of the
 * debounce.
 *
 * Driving the input's `value` straight from the URL would make every keystroke
 * a navigation, and a controlled input re-rendered from an async source loses
 * the caret: type "casino", pause at "cas", and the cursor jumps to the end
 * when the URL catches up. Holding the text locally and PUSHING on a debounce
 * keeps typing exactly as responsive as an unconnected input.
 *
 * ---------------------------------------------------------------------------
 * WHY 300ms
 * ---------------------------------------------------------------------------
 *
 * Long enough that a word is one request rather than six; short enough that
 * the results feel like a consequence of typing rather than of stopping.
 *
 * The debounce is NOT what prevents a stale response from overwriting a newer
 * one - it only reduces how many requests are made. The guarantee comes from
 * the query key: a response for `q=cas` can only ever be written into the
 * `q=cas` entry, so it has nowhere to land once the filter has moved on.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  /** The committed value, from the URL. */
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const committed = useRef(value);

  // Re-sync when the committed value changes from OUTSIDE this component -
  // "clear filters", a back-button navigation, a shared link. Guarded by the
  // ref so it does not fight the user's own typing: the effect only overwrites
  // the box when the incoming value is one this component did not send.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    if (text === committed.current) {
      return;
    }

    const timer = setTimeout(() => {
      committed.current = text;
      onChange(text);
    }, 300);

    // Cleanup on every keystroke: the pending commit for the previous text is
    // cancelled, which is the whole debounce.
    return () => clearTimeout(timer);
  }, [text, onChange]);

  const clear = () => {
    committed.current = '';
    setText('');
    onChange('');
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>

      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary"
        />

        <input
          id={id}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          // Caps the request before it is made, matching the API's own bound
          // so a long paste is refused here rather than by a 400.
          maxLength={100}
          autoComplete="off"
          className="h-11 w-full rounded-control border border-border-input bg-surface pr-10 pl-9 text-sm text-text transition-colors duration-150 placeholder:text-text-secondary hover:border-text-secondary [&::-webkit-search-cancel-button]:hidden"
        />

        {text ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="absolute top-1/2 right-1 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-control text-text-secondary transition-colors duration-150 hover:bg-surface-subtle hover:text-text"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
