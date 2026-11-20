'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import type { NavItem } from '@/lib/nav';
import { SidebarNav } from './sidebar-nav';

/**
 * The navigation drawer, below the `lg` breakpoint.
 *
 * Built on Radix Dialog rather than a hand-rolled panel, and that is the whole
 * justification for the dependency. An accessible drawer has to:
 *
 *   - trap focus inside itself while open, so Tab cannot wander behind it
 *   - return focus to the trigger on close, so a keyboard user does not land
 *     back at the top of the document
 *   - close on Escape
 *   - lock background scroll, so the page behind does not move under a thumb
 *   - mark the rest of the page inert for screen readers
 *
 * Every one of those is easy to get subtly wrong, and getting them wrong makes
 * the drawer unusable for exactly the people the requirement exists to serve.
 */
export function MobileNav({ items, title }: { items: readonly NavItem[]; title: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        // 44px target: comfortable under a thumb, which 24px is not.
        className="inline-flex size-11 items-center justify-center rounded-control text-text-secondary transition-colors duration-150 hover:bg-surface-subtle hover:text-text lg:hidden"
        aria-label="Open navigation menu"
      >
        <Menu className="size-5" aria-hidden="true" />
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-text/40 lg:hidden" />

        <Dialog.Content
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface lg:hidden"
          // Radix would otherwise announce only the title; this says what the
          // panel is for.
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-text">{title}</Dialog.Title>
            <Dialog.Close
              className="inline-flex size-11 items-center justify-center rounded-control text-text-secondary transition-colors duration-150 hover:bg-surface-subtle hover:text-text"
              aria-label="Close navigation menu"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {/* Closing on navigation: otherwise the drawer stays over the page
                the user just asked for. */}
            <SidebarNav items={items} onNavigate={() => setOpen(false)} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
