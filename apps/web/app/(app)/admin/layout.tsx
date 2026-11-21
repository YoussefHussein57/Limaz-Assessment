import { RoleDenied } from '@/components/layout/role-denied';
import { requireUser } from '@/lib/auth';

/**
 * The role gate for platform administration.
 *
 * It renders the 403 explanation instead of its children. That is the right
 * experience, but it is NOT what keeps the admin pages out of a manager's RSC
 * payload - a layout discarding `children` does not stop them rendering
 * (AI_LOG 44). Each admin page carries its own `isPlatformAdmin()` guard for
 * that, and the API refuses a manager with 403 whatever the browser renders.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  if (user.role !== 'PLATFORM_ADMIN') {
    return <RoleDenied audience="admin" />;
  }

  return <>{children}</>;
}
