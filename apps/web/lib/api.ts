import { cookies } from 'next/headers';
import { ApiError } from './api-error';

/**
 * Server-side API access.
 *
 * Server Components call the NestJS service DIRECTLY over the Docker network,
 * not through the `/api/*` proxy. The proxy exists so the BROWSER stays
 * same-origin; a Server Component is already on the server and routing through
 * Next's own route handler would be a pointless extra hop - and would require
 * an absolute URL back to ourselves, which is exactly the self-referential
 * mistake F00-T05 caught in `rewrites()`.
 *
 * The session cookie is HttpOnly, so browser JavaScript cannot read it. A
 * Server Component can, and forwards it here. That is what lets identity be
 * resolved before any HTML is sent.
 */
const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001';
const SESSION_COOKIE = 'limaz_session';

/**
 * Fetches as the signed-in user, or throws.
 *
 * Throws rather than returning a result object, because every caller is a
 * Server Component whose error boundary (`error.tsx`) is the right place to
 * decide what the reader sees. A returned `{ ok: false }` would have to be
 * checked at every call site, and the one place it was forgotten would render
 * `undefined` into the page.
 *
 * `cache: 'no-store'` because the answer is per-user and per-request. A cached
 * expense list is how one company's spending appears on another company's
 * screen.
 */
export async function serverFetch<T>(path: string): Promise<T> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  let response: Response;

  try {
    response = await fetch(`${INTERNAL_API_URL}${path}`, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        // No cookie at all still makes the request: the API answers 401 on
        // its own merits, and letting it do so keeps one authority for who is
        // signed in rather than two that can disagree.
        ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      },
    });
  } catch {
    // The upstream address is never surfaced - it is internal topology.
    throw ApiError.unreachable();
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'request_failed';
  let message = 'The request failed.';

  try {
    const body: unknown = await response.json();

    if (typeof body === 'object' && body !== null) {
      const raw = body as { error?: unknown; message?: unknown };

      if (typeof raw.error === 'string') {
        code = raw.error;
      }

      if (typeof raw.message === 'string') {
        message = raw.message;
      }
    }
  } catch {
    // A non-JSON error body. The status is still meaningful and is what the
    // caller actually branches on.
  }

  return new ApiError(response.status, code, message);
}
