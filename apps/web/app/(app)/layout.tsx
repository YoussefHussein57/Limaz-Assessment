import { AppShell } from '@/components/layout/app-shell';
import { requireUser } from '@/lib/auth';
import { AuthProvider } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';

/**
 * The authenticated shell, and the gate in front of it.
 *
 * A Server Component, so identity is resolved before any HTML is sent: no
 * flash of an unauthenticated frame, no spinner on the user's own name, no
 * client-side waterfall. The HttpOnly cookie is unreadable to browser
 * JavaScript but perfectly readable here, which is what makes this possible.
 *
 * `force-dynamic` because the answer is per-user. A cached shell is how one
 * person's name appears on another person's screen.
 *
 * This is NOT a security boundary. The API answers 401, 403 and 404 on its own
 * merits whatever the browser believes - proven in F02. The redirect exists so
 * nobody is left looking at an empty frame.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <AuthProvider user={user}>
      {/*
        `key={user.id}` is the session-scoped cache guarantee, and it is
        structural rather than procedural.

        A different user unmounts this provider and mounts a new one, so a
        brand-new QueryClient is constructed and there is NO cache to read
        from. The alternative - calling `queryClient.clear()` on logout - works
        only as long as every exit path remembers to call it, and the paths
        include session expiry and a browser back-navigation after logout.

        `requireUser()` above has already resolved the identity on the server,
        so this key is the server's answer to who is signed in, not the
        browser's.
      */}
      <QueryProvider key={user.id}>
        <AppShell>{children}</AppShell>
      </QueryProvider>
    </AuthProvider>
  );
}
