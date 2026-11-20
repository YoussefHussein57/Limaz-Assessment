/**
 * Removes credentials from anything that is about to be written somewhere
 * durable: a log line, an error report, a response body.
 *
 * The threat is not malice, it is habit. Logging a whole request object, or an
 * error that happens to carry headers, is the normal way an API key ends up in
 * a log aggregator - where it is searchable, retained, and visible to people
 * who were never meant to hold it.
 *
 * WHAT THIS IS AND IS NOT
 *
 * Structural defences do the real work: credentials are never put in a
 * response, request headers are never echoed, and `redact()` blanks by KEY
 * NAME, which is exact. Scanning free text for things that look like secrets
 * is a backstop for the cases those miss - a driver error that quotes a
 * connection string, a message somebody interpolated a token into.
 *
 * A backstop is not a guarantee. Treat anything here as reducing the blast
 * radius of a mistake, never as a licence to log a secret on purpose.
 */

/** Headers whose values are credentials and must never be recorded. */
const SENSITIVE_HEADERS = new Set(['x-api-key', 'authorization', 'cookie', 'set-cookie']);

/** Object keys that carry secrets whatever the surrounding shape. */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'passwd',
  'pwd',
  'token',
  'tokenhash',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'keyhash',
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'client_secret',
  'cookie',
  'authorization',
]);

export const REDACTED = '[redacted]';

/**
 * Free text is truncated before scanning.
 *
 * Two reasons. A log line past a few kilobytes is not read by anyone, and the
 * scanning below is linear per pass but runs several passes - handing it an
 * unbounded string turns a logging concern into a stall. Caller-influenced
 * data does reach error messages, so the length is not ours to assume.
 */
const MAX_SCANNED_LENGTH = 8_192;

/**
 * Credential-bearing prefixes that are followed by a delimiter.
 *
 * The value is everything up to whitespace or a delimiter, with NO minimum
 * length - an earlier version required eight characters, so `password=abc`
 * went straight through. Over-redaction is the safe direction here: blanking
 * a harmless word costs nothing, missing a short secret costs everything.
 */
const KEYED_SECRET =
  /\b(secret|client_secret|clientsecret|access_token|accesstoken|refresh_token|refreshtoken|token|api[_-]?key|apikey|x-api-key|password|passwd|pwd)\s*[=:]\s*["']?([^\s"'&,;)\]}]+)/gi;

/** Scheme-style credentials: `Authorization: Bearer <value>`. */
const SCHEME_SECRET = /\b(bearer|basic)\s+([^\s"',;)\]}]+)/gi;

/** Our own API key format, which carries no key name when pasted into prose. */
const LIMAZ_KEY = /\blmz_[a-z0-9]+_[A-Za-z0-9_-]{16,}\b/g;

/** bcrypt modular crypt format. */
const BCRYPT_HASH = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g;

/**
 * Blanks the password inside one URL-shaped token.
 *
 * Written with string indexing rather than a regular expression, which is what
 * makes three separate problems go away at once:
 *
 *   - An EMPTY username. `redis://:secret@host` is legal and a pattern that
 *     required at least one character before the colon let the password
 *     through untouched.
 *   - An `@` INSIDE the password. Stopping at the first `@` redacted only part
 *     of it and left the rest in the log; `lastIndexOf` within the authority
 *     stops at the right one.
 *   - Backtracking. There is none here, so no input length can make this
 *     quadratic.
 *
 * The host is deliberately preserved. An error that no longer says which
 * target failed has been redacted into uselessness, and a redactor that
 * destroys the diagnosis is a redactor somebody removes.
 */
function redactUrlToken(token: string): string {
  const schemeEnd = token.indexOf('://');
  if (schemeEnd <= 0) {
    return token;
  }

  const authorityStart = schemeEnd + 3;

  // The authority runs until the path, query or fragment begins.
  let authorityEnd = token.length;
  for (let i = authorityStart; i < token.length; i += 1) {
    const char = token[i];
    if (char === '/' || char === '?' || char === '#') {
      authorityEnd = i;
      break;
    }
  }

  const authority = token.slice(authorityStart, authorityEnd);

  // Userinfo ends at the LAST '@' in the authority, because a password may
  // legally contain one.
  const at = authority.lastIndexOf('@');
  if (at === -1) {
    return token;
  }

  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon === -1) {
    // A username with no password. Nothing secret to remove.
    return token;
  }

  const username = userinfo.slice(0, colon);
  const hostAndAfter = authority.slice(at + 1);

  return (
    token.slice(0, authorityStart) +
    username +
    ':' +
    REDACTED +
    '@' +
    hostAndAfter +
    token.slice(authorityEnd)
  );
}

/** Applies the URL rule to every whitespace-separated token. */
function redactUrlCredentials(value: string): string {
  if (!value.includes('://')) {
    return value;
  }

  return value
    .split(/(\s+)/)
    .map((part) => (part.includes('://') ? redactUrlToken(part) : part))
    .join('');
}

/** Replaces anything that looks like a credential inside a free-text string. */
export function redactText(value: string): string {
  const scanned =
    value.length > MAX_SCANNED_LENGTH
      ? `${value.slice(0, MAX_SCANNED_LENGTH)} ...[truncated]`
      : value;

  return redactUrlCredentials(scanned)
    .replace(KEYED_SECRET, `$1=${REDACTED}`)
    .replace(SCHEME_SECRET, `$1 ${REDACTED}`)
    .replace(LIMAZ_KEY, REDACTED)
    .replace(BCRYPT_HASH, REDACTED);
}

/**
 * Deep-redacts a value by key name and by pattern.
 *
 * Depth-limited: an error object can hold a cycle or an enormous tree, and a
 * redactor that hangs while preparing a log line has turned a logging concern
 * into an outage.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalised = key.toLowerCase();

      if (SENSITIVE_KEYS.has(normalised) || SENSITIVE_HEADERS.has(normalised)) {
        output[key] = REDACTED;
        continue;
      }

      output[key] = redact(item, depth + 1);
    }

    return output;
  }

  return value;
}
