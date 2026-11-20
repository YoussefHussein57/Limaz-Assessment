import { redirect } from 'next/navigation';
import { getCurrentUser, homePathFor } from '@/lib/auth';

/**
 * The root sends people where they belong.
 *
 * Resolved on the SERVER, so there is no flash of a landing page before the
 * redirect. Signed in: to the workspace for their role. Not: to the login
 * page.
 */
export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const user = await getCurrentUser().catch(() => null);

  redirect(user ? homePathFor(user.role) : '/login');
}
