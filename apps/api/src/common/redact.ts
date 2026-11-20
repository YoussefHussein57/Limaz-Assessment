/**
 * Removes credentials from anything that is about to be written somewhere
 * durable: a log line, an error report, a response body.
 *
 * The threat is not malice, it is habit. Logging a whole request object, or
 * an error that happens to carry headers, is the normal way an API key ends up
 * in a log aggregator - where it is searchable, retained, and visible to
 * people who were never meant to hold it.
 */

/** Headers whose values are credentials and must never be recorded. */
const SENSITIVE_HEADERS = new Set(['x-api-key', 'authorization', 'cookie', 'set-cookie']);

/** Object keys that carry secrets whatever the surrounding shape. */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'keyhash',
  'apikey',
  'secret',
  'cookie',
  'authorization',
]);

export const REDACTED = '[redacted]';

/**
 * Patterns for secrets that travel as bare strings, where no key name gives
 * them away - a key pasted into a free-text log message, for example.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Our own API key format: lmz_<env>_<base64url>
  /\blmz_[a-z0-9]+_[A-Za-z0-9_-]{16,}\b/g,
  // bcrypt modular crypt format
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g,
];

/** Replaces anything that looks like a credential inside a free-text string. */
export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
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
