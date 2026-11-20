/**
 * Removes credentials from anything about to be written somewhere durable: a
 * log line, an error report, a response body.
 *
 * The threat is not malice, it is habit. Logging a whole request object, or an
 * error that happens to carry headers, is the normal way an API key reaches a
 * log aggregator - where it is searchable, retained, and visible to people who
 * were never meant to hold it.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * The real protection is structural: credentials never go into a response,
 * request headers are never echoed, and `redact()` blanks by KEY NAME, which
 * is exact. Scanning free text is a BACKSTOP for what those miss - a driver
 * error quoting a connection string, a message somebody interpolated a token
 * into.
 *
 * A backstop is not a guarantee, and this one has been revised three times as
 * review found cases it missed. That is the nature of pattern-matching
 * arbitrary text: each pass closes real gaps and cannot prove there are none
 * left. Its known limits are listed below rather than left to be discovered.
 *
 * KNOWN LIMITS, accepted deliberately
 *
 *  - A raw '/' inside a URL password is not redacted. RFC 3986 requires it to
 *    be percent-encoded, so such a string is malformed. Catching it means
 *    scanning past the path separator, which then mangles ordinary URLs like
 *    `https://cdn.example.com:8080/img@2x.png` - and a redactor that fills
 *    logs with noise is a redactor somebody switches off.
 *  - A raw quote inside a URL password is not redacted either, for the same
 *    shape of reason. A quote is technically a sub-delim and so legal, but it
 *    is also what closes a string in every structured log. Scanning past it
 *    turns `{"url":"https://host","email":"a@b.com"}` into a mangled line with
 *    the address blanked, because the authority would run on to that '@'.
 *    Keeping logs parseable wins; the password should be percent-encoded.
 *  - A secret with no key name, no recognisable prefix and no known format is
 *    indistinguishable from an identifier. Nothing here will catch it.
 *  - Input is truncated, so a credential past the limit is never scanned. The
 *    cut is taken at a whitespace boundary so it cannot split a token and emit
 *    half a secret.
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
 * Free text is bounded before scanning.
 *
 * A log line past a few kilobytes is not read by anyone, and caller-influenced
 * data does reach error messages, so the length is not ours to assume.
 */
const MAX_SCANNED_LENGTH = 8_192;

/**
 * Credential-bearing key names followed by a delimiter.
 *
 * The separator allows an optional closing quote before it, so the JSON shape
 * `"password": "hunter2"` matches - which an earlier version did not, and
 * structured logs are JSON.
 *
 * There is NO minimum value length: an eight-character floor let `password=abc`
 * through. Over-redaction is the safe direction, since blanking a harmless
 * word costs nothing and missing a short secret costs everything.
 *
 * A delimiter is required rather than accepting bare whitespace. `password is
 * incorrect` would otherwise have `is` blanked on every authentication
 * failure, and noise is how redaction ends up being removed.
 */
const KEYED_SECRET =
  /\b(secret|client_secret|clientsecret|access_token|accesstoken|refresh_token|refreshtoken|token|api[_-]?key|apikey|x-api-key|password|passwd|pwd)\b["']?\s*[=:]\s*["']?([^\s"'&,;)\]}]+)/gi;

/**
 * Scheme-style credentials, where whitespace IS the separator.
 * `Authorization: Bearer <value>`, `token <value>`.
 */
const SCHEME_SECRET = /\b(bearer|basic|token)\s+([^\s"',;)\]}]+)/gi;

/** Our own API key format, which carries no key name when pasted into prose. */
const LIMAZ_KEY = /\blmz_[a-z0-9]+_[A-Za-z0-9_-]{16,}\b/g;

/** bcrypt modular crypt format. */
const BCRYPT_HASH = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g;

/**
 * Characters that end a URL authority.
 *
 * ONLY characters that RFC 3986 forbids inside userinfo. ',' and ';' are
 * deliberately absent: they are sub-delims, so they are legal in a password,
 * and treating them as terminators cut the authority short and left the
 * password unredacted. Measured: `postgresql://u:pa,ss@host/db` emitted
 * `pa,ss` intact.
 *
 * That was a regression introduced while fixing a different case - lists of
 * URLs separated by commas. Lists are handled by looking ahead to where the
 * NEXT scheme begins instead, which needs no assumption about what a password
 * may contain.
 */
const AUTHORITY_TERMINATORS = new Set([
  '/',
  '?',
  '#',
  ' ',
  '\t',
  '\n',
  '\r',
  '"',
  "'",
  '<',
  '>',
  '|',
  '\\',
  '`',
]);

/** Characters a URL scheme name may contain, per RFC 3986. */
const SCHEME_CHARS = /[A-Za-z0-9+.-]/;

/**
 * Blanks the password in every URL in the string, in one linear pass.
 *
 * Written with string indexing rather than a regular expression, which removes
 * three problems at once:
 *
 *   - An EMPTY username. `redis://:secret@host` is legal, and requiring a
 *     character before the colon let the password through untouched.
 *   - An '@' INSIDE the password. Stopping at the first one redacted half of
 *     it; the authority is scanned to its LAST '@'.
 *   - Backtracking. There is none, so no input length makes this quadratic.
 *
 * It walks EVERY '://' in the string, not the first per whitespace-separated
 * token: a message listing two connection strings separated by a comma is one
 * token, and the second used to go unredacted.
 *
 * The host is preserved deliberately. An error that no longer says which
 * target failed has been redacted into uselessness.
 */
function redactUrlCredentials(value: string): string {
  // Every '://' is located up front, so each URL is bounded by where the NEXT
  // one starts rather than by guessing which punctuation ends this one. That
  // is what lets a password legally contain ',' and ';' while a
  // comma-separated list of connection strings still splits correctly.
  const schemes: number[] = [];
  for (let i = value.indexOf('://'); i !== -1; i = value.indexOf('://', i + 3)) {
    schemes.push(i);
  }

  if (schemes.length === 0) {
    return value;
  }

  let output = '';
  let cursor = 0;

  for (let index = 0; index < schemes.length; index += 1) {
    const scheme = schemes[index]!;
    if (scheme < cursor) {
      continue;
    }

    const authorityStart = scheme + 3;

    // This URL cannot extend past the start of the next one's SCHEME NAME, so
    // walk back from the next '://' over the characters a scheme may contain.
    let limit = value.length;
    const nextScheme = schemes[index + 1];
    if (nextScheme !== undefined) {
      let back = nextScheme;
      while (back > authorityStart && SCHEME_CHARS.test(value[back - 1]!)) {
        back -= 1;
      }
      limit = back;
    }

    let authorityEnd = authorityStart;
    while (authorityEnd < limit && !AUTHORITY_TERMINATORS.has(value[authorityEnd]!)) {
      authorityEnd += 1;
    }

    const authority = value.slice(authorityStart, authorityEnd);
    const at = authority.lastIndexOf('@');
    const colon = at === -1 ? -1 : authority.slice(0, at).indexOf(':');

    if (at === -1 || colon === -1) {
      // No userinfo, or a username with no password: nothing secret here.
      output += value.slice(cursor, authorityEnd);
    } else {
      output +=
        value.slice(cursor, authorityStart) +
        authority.slice(0, colon + 1) +
        REDACTED +
        '@' +
        authority.slice(at + 1);
    }

    cursor = authorityEnd;
  }

  return output + value.slice(cursor);
}

/**
 * Bounds the input WITHOUT emitting a partial token.
 *
 * Cutting at an arbitrary index can land inside a connection string, leaving a
 * head like `postgresql://u:SECRE` that carries no '@' - so nothing redacts it
 * and part of the password is logged anyway. Measured: with no whitespace in
 * the input at all, nine different padding lengths leaked a prefix.
 *
 * Three steps, each a fallback for the one before:
 *   1. Cut back to the last whitespace, so only whole tokens survive.
 *   2. Failing that, cut back to the last token delimiter.
 *   3. Failing that - one enormous unbroken token - drop the tail entirely if
 *      it looks like it could carry a credential. A truncation marker tells
 *      more than half a password does.
 */
function bound(value: string): string {
  if (value.length <= MAX_SCANNED_LENGTH) {
    return value;
  }

  const slice = value.slice(0, MAX_SCANNED_LENGTH);

  const lastWhitespace = slice.search(/\s\S*$/);
  if (lastWhitespace > 0) {
    return `${slice.slice(0, lastWhitespace)} ...[truncated]`;
  }

  const lastDelimiter = Math.max(
    slice.lastIndexOf(','),
    slice.lastIndexOf(';'),
    slice.lastIndexOf('"'),
    slice.lastIndexOf("'"),
  );
  if (lastDelimiter > 0) {
    return `${dropUnterminatedUrl(slice.slice(0, lastDelimiter + 1))} ...[truncated]`;
  }

  // One unbroken token. A ':' anywhere in it means it could be `scheme://
  // user:secret` or `key:value`, and we cannot tell where the value starts,
  // so none of it is safe to emit.
  return slice.includes(':') ? '[truncated]' : `${slice} ...[truncated]`;
}

/**
 * Removes a URL that the cut left half-written.
 *
 * `,` and `;` are legal inside a password, so cutting back to one can land in
 * the middle of userinfo: `postgresql://u:pa,` carries no '@', so nothing
 * recognises it as a credential and the fragment is logged. Any trailing
 * `scheme://` that has not yet reached its '@' is dropped entirely.
 */
function dropUnterminatedUrl(kept: string): string {
  const lastScheme = kept.lastIndexOf('://');
  if (lastScheme === -1) {
    return kept;
  }

  const tail = kept.slice(lastScheme + 3);

  // Reached its '@' - the authority is complete and redaction will handle it.
  if (tail.includes('@')) {
    return kept;
  }

  // No ':' in the tail means no password can have started yet.
  if (!tail.includes(':')) {
    return kept;
  }

  // Walk back over the scheme name so the fragment goes with it.
  let start = lastScheme;
  while (start > 0 && SCHEME_CHARS.test(kept[start - 1]!)) {
    start -= 1;
  }

  return kept.slice(0, start);
}

/** Replaces anything that looks like a credential inside a free-text string. */
export function redactText(value: string): string {
  return redactUrlCredentials(bound(value))
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
