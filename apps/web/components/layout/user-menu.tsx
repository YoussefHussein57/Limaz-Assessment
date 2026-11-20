'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useCurrentUser } from '@/providers/auth-provider';

const ROLE_LABEL: Record<string, string> = {
  MANAGER: 'Manager',
  PLATFORM_ADMIN: 'Platform admin',
};

/**
 * The signed-in identity, and the way out.
 *
 * Radix DropdownMenu rather than a hand-rolled popover, which is the second
 * and last justification for a Radix dependency. A menu has to answer to
 * arrow keys, close on Escape, return focus to its trigger, and carry
 * `role="menu"` with the right `aria-expanded` - and a menu that traps a
 * keyboard user is worse than no menu.
 */
export function UserMenu() {
  const user = useCurrentUser();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    if (signingOut) {
      return;
    }
    setSigningOut(true);

    try {
      // Through the same-origin proxy, with the CSRF header the API requires
      // on every state-changing browser request.
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'x-limaz-client': '1' },
      });
    } catch {
      // The session may already be gone, or the API unreachable. Either way
      // the right next screen is the login page: staying here would show a
      // shell for a session that no longer works.
    }

    router.replace('/login?reason=signedout');

    // The revocation happened on the server; this clears Next's client-side
    // Router Cache. Without it the next navigation can replay a shell
    // rendered for the previous identity (test F02.1-T18).
    router.refresh();
  }

  const initials = user.displayName
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex h-11 items-center gap-2 rounded-control px-2 text-left transition-colors duration-150 hover:bg-surface-subtle">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-subtle text-xs font-semibold text-accent"
        >
          {initials}
        </span>

        {/* Hidden under 640px: the name is in the menu itself, and a header
            that wraps on a 360px screen is worse than a compact one. */}
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-sm font-medium text-text">{user.displayName}</span>
          <span className="block truncate text-xs text-text-secondary">
            {ROLE_LABEL[user.role] ?? user.role}
          </span>
        </span>

        <ChevronDown className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="sr-only">Open account menu</span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-60 rounded-card border border-border bg-surface p-1 shadow-sm"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-text">{user.displayName}</p>
            <p className="truncate text-xs text-text-secondary">{user.email}</p>
            <p className="mt-1 text-xs text-text-secondary">
              {ROLE_LABEL[user.role] ?? user.role}
              {user.company ? ` · ${user.company.name}` : ' · All companies'}
            </p>
          </div>

          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          <DropdownMenu.Item
            onSelect={(event) => {
              // Radix closes the menu on select; preventing the default keeps
              // it open until the request settles, so the spinner is visible.
              event.preventDefault();
              void signOut();
            }}
            disabled={signingOut}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-control px-3 text-sm text-text outline-none select-none data-[disabled]:opacity-60 data-[highlighted]:bg-surface-subtle"
          >
            {signingOut ? (
              <Spinner label="Signing out" />
            ) : (
              <LogOut className="size-4" aria-hidden="true" />
            )}
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
