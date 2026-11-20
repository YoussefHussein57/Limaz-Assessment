import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/nav';
import { cn } from '@/lib/cn';

/*
 * No 'use client' directive here on purpose.
 *
 * That directive marks the BOUNDARY between the server and client graphs, and
 * props crossing it must be serializable - so a callback prop like onNavigate
 * would be rejected. This module is only ever imported by components that are
 * already client components, so it inherits the client graph and never forms
 * a boundary of its own.
 */

/**
 * The navigation list, shared by the desktop sidebar and the mobile drawer.
 *
 * One component for both so the two can never drift apart - the assessment
 * asks for distinct navigation per role, not two separate implementations of
 * the same list.
 */
export function SidebarNav({
  items,
  onNavigate,
}: {
  items: readonly NavItem[];
  /** Lets the drawer close itself when a link is followed. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  /*
   * Which link is "the page you are on".
   *
   * An exact match alone is wrong: on /dashboard/expenses/<id> nothing would
   * be highlighted, so a reader three clicks deep loses their orientation.
   * A plain prefix match is also wrong: /dashboard is a prefix of
   * /dashboard/expenses, so Overview would light up on every page.
   *
   * The LONGEST matching prefix is the answer, which is the same rule routers
   * use to pick a route. It is computed once for the whole list rather than
   * per item, so exactly one link can ever be marked.
   */
  const current = items
    .filter((item) => !item.comingIn)
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = current === item.href;

          if (item.comingIn) {
            return (
              <li key={item.href}>
                {/*
                  A span, not a disabled link. There is no destination, so
                  there is nothing to focus or activate - and a focusable
                  control that does nothing is worse than none for keyboard
                  users. The reason is written out rather than implied by
                  dimming, which a screen reader cannot see.
                */}
                <span className="flex items-center gap-3 rounded-control px-3 py-2 text-sm text-text-secondary opacity-60">
                  <item.Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                  <span className="ml-auto text-xs whitespace-nowrap">{item.comingIn}</span>
                </span>
              </li>
            );
          }

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                // aria-current is how assistive tech learns which page it is
                // on. Colour alone does not say it.
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium',
                  'transition-colors duration-150',
                  active
                    ? 'bg-accent-subtle text-accent'
                    : 'text-text-secondary hover:bg-surface-subtle hover:text-text',
                )}
              >
                <item.Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
