/**
 * Server-side API access.
 *
 * Server Components call the NestJS service directly over the Docker network.
 * Client Components must use the relative path `/api/...` so the request goes
 * through the Next proxy and stays same-origin.
 */
const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001';

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly error?: string;
}

export async function serverFetch<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${INTERNAL_API_URL}${path}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });

    const data = (await response.json()) as T;
    return { ok: response.ok, status: response.status, data };
  } catch {
    // The reason is logged by the platform; the page shows a generic state.
    return { ok: false, status: 0, data: null, error: 'api unreachable' };
  }
}
