/**
 * Joins class names, dropping anything falsy.
 *
 * Six lines instead of `clsx` plus `tailwind-merge`, which together would add
 * two dependencies to solve a problem this project does not have: every call
 * site here is ours, so there are no conflicting utility classes arriving from
 * outside to resolve.
 *
 * If component variants ever need to be overridden from outside, that is the
 * moment to reach for `tailwind-merge` - not before.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
