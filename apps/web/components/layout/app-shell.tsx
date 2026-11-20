'use client';

import type { ReactNode } from 'react';
import { Wallet } from 'lucide-react';
import { navFor, workspaceLabel } from '@/lib/nav';
import { useCurrentUser } from '@/providers/auth-provider';
import { MobileNav } from './mobile-nav';
import { SidebarNav } from './sidebar-nav';
import { UserMenu } from './user-menu';

/**
 * The authenticated frame: sidebar on desktop, drawer below `lg`.
 *
 * ONE shell for both roles. The navigation differs - that comes from
 * `navFor(role)` - but the structure, spacing and behaviour do not, which is
 * what stops the manager and admin areas drifting into two different-looking
 * products.
 *
 * The breakpoint is `lg` (1024px) rather than `md`. At 768px a 260px sidebar
 * leaves roughly 500px of content, which is too narrow for the expense table
 * F06 will put here.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const items = navFor(user.role);
  const workspace = workspaceLabel(user.role);

  return (
    <div className="min-h-dvh">
      {/*
        Keyboard users should not have to tab through the whole navigation on
        every page. Visually hidden until focused (WCAG 2.4.1).
      */}
      <a
        href="#main"
        className="sr-only rounded-control bg-accent px-4 py-2 text-sm text-text-inverse focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to content
      </a>

      {/* Desktop sidebar: fixed, so long content scrolls under it. */}
      <aside className="fixed inset-y-0 left-0 hidden w-65 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-16 items-center gap-2 border-b border-border px-5">
          <Wallet className="size-5 text-accent" aria-hidden="true" />
          <span className="text-sm font-semibold text-text">LIMAZ</span>
        </div>

        <div className="px-5 pt-4 pb-2">
          <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">
            {workspace}
          </p>
          {user.company ? (
            <p className="mt-1 truncate text-sm font-medium text-text">{user.company.name}</p>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          <SidebarNav items={items} />
        </div>
      </aside>

      <div className="lg:pl-65">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-surface px-3 sm:px-5">
          <MobileNav items={items} title={workspace} />

          {/* The brand only shows where the sidebar does not, so it never
              appears twice. */}
          <span className="flex items-center gap-2 lg:hidden">
            <Wallet className="size-5 text-accent" aria-hidden="true" />
            <span className="text-sm font-semibold text-text">LIMAZ</span>
          </span>

          <div className="ml-auto">
            <UserMenu />
          </div>
        </header>

        {/* max-w keeps line lengths readable at 1920px; without it the content
            stretches to the full width and becomes hard to scan. */}
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
