import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { CurrentUser, UserRole } from './auth-shared';

/**
 * Server-side identity resolution.
 *
 * The session cookie is HttpOnly, so browser JavaScript cannot read it - but a
 * Server Component can, and can forward it. That is what makes this approach
 * work at all, and why identity is resolved BEFORE any HTML reaches the
 * browser: no flash of an unauthenticated shell, no loading spinner on the
 * user's own name, no client-side waterfall.
 *
 * None of this is a security boundary. The API returns 401, 403 and 404 on its
 * own merits regardless of what the browser believes (proven in F02). The
 * redirects here exist so a person is not left looking at an empty frame.
 */

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001';
const SESSION_COOKIE = 'limaz_session';

export type { CurrentUser, UserRole } from './auth-shared';
export { homePathFor } from './auth-shared';

interface MeResponse {
  callerType: 'user' | 'api-key';
  user: { id: string; email: string; displayName: string; role: UserRole } | null;
  company: { id: string; name: string } | null;
}

/**
 * Resolves the signed-in user, or null.
 *
 * Returns null rather than throwing for every "not signed in" case, so the
 * caller decides what that means: the app shell redirects, the login page
 * sends an already-authenticated visitor onward.
 *
 * `cache: 'no-store'` because the answer is per-request and per-user. A cached
 * identity is how one person's name ends up on another person's screen.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  if (!token) {
    // No cookie at all: skip the round trip entirely.
    return null;
  }

  let response: Response;

  try {
    response = await fetch(`${INTERNAL_API_URL}/v1/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    // The API is unreachable. Distinguished from "not signed in" by the
    // caller, because telling someone to log in again when the backend is
    // simply down sends them into a loop they cannot escape.
    throw new ApiUnreachableError();
  }

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new ApiUnreachableError();
  }

  const body = (await response.json()) as MeResponse;

  // An API key is a company, not a person. It has no business holding a
  // browser session, and if one ever arrives here it is not a user.
  if (body.callerType !== 'user' || !body.user) {
    return null;
  }

  return { ...body.user, company: body.company };
}

/** Thrown when the API cannot be reached at all, as opposed to refusing us. */
export class ApiUnreachableError extends Error {
  constructor() {
    super('The API could not be reached.');
    this.name = 'ApiUnreachableError';
  }
}

/**
 * Resolves the user or sends them to the login page.
 *
 * `/login` deliberately lives OUTSIDE the protected route group. If it were
 * inside, this redirect would land on a page that runs this check, which would
 * redirect again - an infinite loop (test F02.1-T09).
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login?reason=signin');
  }

  return user;
}
