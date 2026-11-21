import { FileText, Home, Building2, Inbox, CreditCard, ScrollText, Settings } from 'lucide-react';
import type { UserRole } from './auth-shared';

export interface NavItem {
  readonly label: string;
  readonly href: string;
  readonly Icon: typeof Home;
  /**
   * The destination does not exist yet.
   *
   * Rendered as disabled with a visible note rather than hidden. A navigation
   * that silently omits what is coming makes the product look smaller than it
   * is; one that links to a 404 makes it look broken. Saying so is the honest
   * third option, and it is what the assessment asks for.
   */
  readonly comingIn?: string;
}

const MANAGER_NAV: readonly NavItem[] = [
  { label: 'Overview', href: '/dashboard', Icon: Home },
  { label: 'Expenses', href: '/dashboard/expenses', Icon: FileText },
  { label: 'Reviews', href: '/dashboard/reviews', Icon: ScrollText },
  { label: 'Policy', href: '/dashboard/policy', Icon: Settings },
];

/*
 * One destination, not three.
 *
 * API keys live inside a company's own page rather than in a separate
 * section: a key only means anything in the context of the company it
 * authenticates, and a flat list of every key on the deployment would be a
 * screen nobody has a reason to open. A separate "Overview" was dropped for
 * the same reason - the companies list already shows the one thing worth
 * knowing at a glance, which companies cannot authenticate.
 */
const ADMIN_NAV: readonly NavItem[] = [
  { label: 'Companies', href: '/admin', Icon: Building2 },
  // F12. Both are real destinations with real data behind them - the rule
  // above still holds: nothing is listed that does not work.
  //
  // The simulator link is shown even when SANDBOX_SIMULATOR_ENABLED is off,
  // and the page then says so in words. Hiding it would make a deliberate
  // deployment decision look like a missing feature, and the API refuses the
  // endpoint either way - the link is not what protects it.
  { label: 'Payment simulator', href: '/admin/simulator', Icon: CreditCard },
  { label: 'Webhook events', href: '/admin/webhook-events', Icon: Inbox },
];

/**
 * Navigation is derived from the role the SERVER resolved.
 *
 * Hiding a link is presentation, not protection: the API answers 403 whatever
 * the browser chooses to render (F02-T12). This exists so a manager is not
 * shown doors that will not open for them.
 */
export function navFor(role: UserRole): readonly NavItem[] {
  return role === 'PLATFORM_ADMIN' ? ADMIN_NAV : MANAGER_NAV;
}

export function workspaceLabel(role: UserRole): string {
  return role === 'PLATFORM_ADMIN' ? 'Platform administration' : 'Company workspace';
}
