/**
 * One error type for both sides of the server/client line.
 *
 * It lives in its own module because `lib/api.ts` imports `next/headers`,
 * which exists only on the server: importing a single value from there is
 * enough to pull `next/headers` into the browser bundle and fail the build.
 * That already happened once in F02.1 and the lesson is written down in
 * `auth-shared.ts`.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The server's machine-readable `error` field, when it sent one. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** The request never reached the API, as opposed to being refused by it. */
  static unreachable(): ApiError {
    return new ApiError(0, 'unreachable', 'Could not reach the server.');
  }

  /** 401 and 403 are not worth retrying - the answer will not change. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** A client mistake. Retrying sends the same bad request again. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/**
 * What to put on screen.
 *
 * Deliberately NOT the server's own message for a 5xx. The API already
 * withholds internals from its 500 bodies, and this is the second layer:
 * whatever arrives, the reader gets a sentence they can act on rather than a
 * stack trace or a database error.
 */
export function userMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Try again.';
  }

  if (error.status === 0) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  if (error.status === 401) {
    return 'Your session has expired. Sign in again to continue.';
  }

  if (error.status === 403) {
    return 'You do not have access to this.';
  }

  if (error.status === 404) {
    return 'That expense does not exist, or it belongs to another company.';
  }

  if (error.status >= 500) {
    return 'The server had a problem handling that. Nothing was changed.';
  }

  // A 4xx the client caused: the API's message names the offending parameter
  // and the caller supplied it themselves, so echoing it helps rather than
  // leaks.
  return error.message;
}
