import { ApiError } from './api-error';

/**
 * Browser-side API access.
 *
 * ---------------------------------------------------------------------------
 * RELATIVE PATHS ONLY
 * ---------------------------------------------------------------------------
 *
 * Every request goes to `/api/...` on the WEB origin and is forwarded
 * server-side by the route handler in `app/api/[...path]/route.ts`. The
 * browser therefore never talks to the API's origin, which is what makes all
 * of the following true at once:
 *
 *   - the session cookie stays first-party, so `SameSite=Lax` keeps working
 *     as CSRF protection
 *   - no CORS configuration exists anywhere, which means the browser's deny
 *     default is never relaxed
 *   - the API's address is never in a URL the browser can see
 *
 * An absolute URL here would undo all three (ADR-008, assumption A10).
 *
 * `credentials` is left at its default. Same-origin requests send cookies
 * already, and setting `'include'` would be a statement about cross-origin
 * requests this application deliberately never makes.
 */
const API_BASE = '/api';

/**
 * The header `CsrfGuard` requires on state-changing requests.
 *
 * Sent on reads too. It costs nothing, it keeps one code path, and it means a
 * route that becomes state-changing later does not start failing because the
 * header was only added where it was strictly needed.
 */
const CLIENT_HEADER = { 'x-limaz-client': '1' } as const;

/**
 * GET as the signed-in user.
 *
 * `signal` is threaded through from TanStack Query, which hands every query
 * function an AbortSignal and aborts it when the query is cancelled - a
 * filter change, an unmount, a new keystroke. Without passing it, superseded
 * requests would run to completion and keep a connection busy for a result
 * nobody will read.
 */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...CLIENT_HEADER },
      signal,
    });
  } catch (error) {
    // An aborted request is not a failure and must NOT be converted into one:
    // TanStack Query treats an AbortError as a cancellation, and anything
    // else as an error it may retry and will show to the reader.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    throw ApiError.unreachable();
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return (await response.json()) as T;
}

/**
 * A state-changing request.
 *
 * `x-limaz-client` is what `CsrfGuard` requires, and it is one of the four
 * layers protecting these routes: `SameSite=Lax` on the cookie, no CORS
 * configuration anywhere, this header, and a server-side `Origin` check. A
 * cross-site form post can reach the server but cannot set a custom header,
 * so it fails here (F02).
 *
 * NO `signal` parameter, deliberately. A GET that is abandoned costs nothing;
 * an abandoned POST may have already committed on the server, and cancelling
 * it client-side would leave the UI believing nothing happened while the
 * database says otherwise. Mutations here run to completion and their result
 * is reconciled.
 */
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...CLIENT_HEADER,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // AMBIGUOUS. The request may have reached the server and committed before
    // the connection failed. The caller must reconcile against the server
    // rather than assume nothing happened - see `resolve-actions.tsx`.
    throw ApiError.unreachable();
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  // 204 and an empty body are valid successful answers.
  if (response.status === 204) {
    return undefined as T;
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
    // A non-JSON error body - the proxy's own 502, for instance. The status
    // is what the caller branches on and it is still meaningful.
  }

  return new ApiError(response.status, code, message);
}

/** Builds a query string, omitting anything empty. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }

  const rendered = search.toString();

  return rendered ? `?${rendered}` : '';
}
