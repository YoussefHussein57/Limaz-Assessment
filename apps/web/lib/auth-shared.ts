/**
 * Auth types and pure helpers, safe on BOTH sides of the server/client line.
 *
 * `lib/auth.ts` imports `next/headers`, which exists only on the server, so
 * anything a client component needs has to live here instead. Importing a
 * single value from the server module is enough to pull `next/headers` into
 * the browser bundle and fail the build - which is exactly what happened when
 * the login form imported `homePathFor` from there.
 *
 * The split is along a real line: this file holds data shapes and a pure
 * function; that one reads a cookie and calls the API.
 */

export type UserRole = 'MANAGER' | 'PLATFORM_ADMIN';

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly company: { readonly id: string; readonly name: string } | null;
}

/** Where each role belongs after signing in. */
export function homePathFor(role: UserRole): string {
  return role === 'PLATFORM_ADMIN' ? '/admin' : '/dashboard';
}
