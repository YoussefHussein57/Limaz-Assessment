'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { CurrentUser } from '@/lib/auth-shared';

const AuthContext = createContext<CurrentUser | null>(null);

/**
 * Carries the user the SERVER already resolved down to client components.
 *
 * It fetches nothing. That distinction is the whole reason Context is the
 * right tool here and TanStack Query is not: there is no server state to
 * cache, synchronise or invalidate - just one value, known before render,
 * that the sidebar and the user menu need.
 *
 * TanStack Query arrives in F06, where expenses and reviews bring real
 * caching and real mutations. Adding it now would be a dependency with
 * nothing to do.
 */
export function AuthProvider({ user, children }: { user: CurrentUser; children: ReactNode }) {
  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>;
}

export function useCurrentUser(): CurrentUser {
  const user = useContext(AuthContext);

  if (!user) {
    // Reaching here means a client component is rendering outside the
    // authenticated shell. Throwing beats returning null, which would be
    // silently rendered as an empty name.
    throw new Error('useCurrentUser was called outside AuthProvider.');
  }

  return user;
}
