import { z } from 'zod';

/**
 * Runtime configuration contract for the API process.
 *
 * Every variable the process depends on is declared here exactly once. Nothing
 * reads `process.env` directly anywhere else in the codebase, so there is no
 * path by which an undeclared or malformed variable can reach business code.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  API_PORT: z.coerce
    .number({ error: 'API_PORT must be a number' })
    .int('API_PORT must be an integer')
    .min(1, 'API_PORT must be between 1 and 65535')
    .max(65535, 'API_PORT must be between 1 and 65535')
    .default(3001),

  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required')
    .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a PostgreSQL connection string (postgresql://...)',
    }),

  /**
   * The browser origin this API expects.
   *
   * A request that CARRIES an Origin header must match it. Requests with no
   * Origin - every server-to-server API key caller - are unaffected, because
   * such clients never send one. Requiring it unconditionally would break
   * them, which is why the check is "if present, must match" rather than
   * "must be present".
   *
   * The Origin header is a forbidden header name: page JavaScript cannot
   * forge it, the browser sets it. So when it is present it is trustworthy.
   */
  APP_ORIGIN: z
    .string({ error: 'APP_ORIGIN is required' })
    .min(1, 'APP_ORIGIN is required')
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'APP_ORIGIN must be an absolute origin, for example http://localhost:3000',
    })
    .refine((value) => !value.endsWith('/'), {
      message: 'APP_ORIGIN must not end with a slash - browsers never send one',
    })
    .default('http://localhost:3000'),

  /** Absolute session lifetime. Enforced in SQL, not only in the cookie. */
  SESSION_TTL_HOURS: z.coerce
    .number({ error: 'SESSION_TTL_HOURS must be a number' })
    .int('SESSION_TTL_HOURS must be an integer')
    .min(1, 'SESSION_TTL_HOURS must be at least 1')
    .max(720, 'SESSION_TTL_HOURS must be 720 or fewer')
    .default(8),

  /**
   * Secure cookies in every environment. Chrome and Firefox both treat
   * http://localhost as a secure context, so this does not need to differ
   * between development and production - and making it differ is how
   * production-only security bugs happen.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * bcrypt work factor for passwords only.
   *
   * Session tokens and API keys are hashed with SHA-256 instead: they carry
   * 256 bits of CSPRNG entropy, so a slow hash buys no security, and bcrypt's
   * per-row salt would make an indexed lookup impossible.
   */
  BCRYPT_COST: z.coerce
    .number({ error: 'BCRYPT_COST must be a number' })
    .int('BCRYPT_COST must be an integer')
    .min(10, 'BCRYPT_COST must be at least 10')
    .max(15, 'BCRYPT_COST above 15 makes login unusably slow')
    .default(10),

  /**
   * Maximum connections in the pg pool.
   *
   * This must stay comfortably above the concurrency used by any concurrency
   * test. With a pool of 1, five "simultaneous" requests queue inside the pool
   * and execute one after another - the test then passes without ever
   * exercising the database-level serialisation it claims to prove. Tracked as
   * risk R-10.
   */
  DB_POOL_MAX: z.coerce
    .number({ error: 'DB_POOL_MAX must be a number' })
    .int('DB_POOL_MAX must be an integer')
    .min(1, 'DB_POOL_MAX must be at least 1')
    .max(100, 'DB_POOL_MAX must be 100 or fewer')
    .default(10),

  // ---------------------------------------------------------------------------
  // Card webhook intake (F12)
  // ---------------------------------------------------------------------------

  /**
   * The key that encrypts every company's webhook signing secret at rest.
   *
   * REQUIRED, with no default, in every environment.
   *
   * A default would be a hardcoded production encryption key in a public
   * repository, which is the same as no encryption at all. Making it required
   * in production and optional elsewhere is the pattern this codebase already
   * rejects for `COOKIE_SECURE`: a security property that differs between
   * environments is a security property nobody tests.
   *
   * 32 bytes, because AES-256-GCM takes a 256-bit key. The length is checked
   * here rather than at first use, so a short key refuses to start the process
   * instead of failing on the first webhook, hours later.
   *
   * The VALUE is never logged, never returned and never included in an error
   * message - the refusal below names the variable and says what is wrong with
   * it, which is all an operator needs.
   */
  WEBHOOK_ENCRYPTION_KEY: z
    .string({ error: 'WEBHOOK_ENCRYPTION_KEY is required' })
    .min(1, 'WEBHOOK_ENCRYPTION_KEY is required')
    .refine((value) => decodeBase64Key(value)?.length === 32, {
      message:
        'WEBHOOK_ENCRYPTION_KEY must be 32 bytes, base64 encoded ' +
        "(generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")",
    }),

  /**
   * How far a delivery's signature timestamp may sit from our clock.
   *
   * This is replay protection, and it is a trade-off in both directions. Too
   * tight and a legitimate delivery fails because the provider's clock drifts
   * or its retry queue was backed up; too loose and a captured request stays
   * replayable for that long.
   *
   * Five minutes is the common industry default and is what this contract
   * documents. Note that it bounds the DELIVERY timestamp, not the
   * transaction's `spentAt`: a payment from last Tuesday is perfectly normal,
   * and is accepted as long as the request carrying it was signed just now.
   */
  WEBHOOK_TOLERANCE_SECONDS: z.coerce
    .number({ error: 'WEBHOOK_TOLERANCE_SECONDS must be a number' })
    .int('WEBHOOK_TOLERANCE_SECONDS must be an integer')
    .min(30, 'WEBHOOK_TOLERANCE_SECONDS must be at least 30')
    .max(3_600, 'WEBHOOK_TOLERANCE_SECONDS must be 3600 or fewer')
    .default(300),

  /** How many times a worker may claim one event before it becomes terminal. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce
    .number({ error: 'WEBHOOK_MAX_ATTEMPTS must be a number' })
    .int('WEBHOOK_MAX_ATTEMPTS must be an integer')
    .min(1, 'WEBHOOK_MAX_ATTEMPTS must be at least 1')
    .max(20, 'WEBHOOK_MAX_ATTEMPTS must be 20 or fewer')
    .default(5),

  /**
   * How long a worker's claim is respected before another may take the event.
   *
   * This is the crash-recovery window. Too short and a slow-but-alive worker
   * has its event stolen while it is still working on it - which is safe,
   * because expense submission is idempotent, but wasteful. Too long and a
   * genuinely dead worker's events sit untouched for that long.
   */
  WEBHOOK_CLAIM_LEASE_SECONDS: z.coerce
    .number({ error: 'WEBHOOK_CLAIM_LEASE_SECONDS must be a number' })
    .int('WEBHOOK_CLAIM_LEASE_SECONDS must be an integer')
    .min(5, 'WEBHOOK_CLAIM_LEASE_SECONDS must be at least 5')
    .max(3_600, 'WEBHOOK_CLAIM_LEASE_SECONDS must be 3600 or fewer')
    .default(60),

  /** Idle poll interval. Bounded below so a misconfiguration cannot busy-loop. */
  WEBHOOK_POLL_INTERVAL_MS: z.coerce
    .number({ error: 'WEBHOOK_POLL_INTERVAL_MS must be a number' })
    .int('WEBHOOK_POLL_INTERVAL_MS must be an integer')
    .min(100, 'WEBHOOK_POLL_INTERVAL_MS must be at least 100')
    .max(60_000, 'WEBHOOK_POLL_INTERVAL_MS must be 60000 or fewer')
    .default(1_000),

  /**
   * Whether this process runs the background worker.
   *
   * On in a normal deployment. Off in the test suite, where the worker is
   * driven one event at a time so that "the event was processed" is an
   * assertion rather than a sleep.
   */
  WEBHOOK_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Whether the sandbox payment simulator exists.
   *
   * An EXPLICIT flag, deliberately not derived from `NODE_ENV`.
   * `NODE_ENV=production` means "this is a production BUILD", and the Docker
   * image sets it in every environment including a laptop - the exact mistake
   * that made development stacks mint keys labelled `lmz_prod_` (AI_LOG 42).
   * A flag that decides whether an endpoint capable of forging signed provider
   * requests exists must not be derived from a signal that lies.
   *
   * OFF by default, so a deployment that says nothing gets the safe answer.
   * The repository's own compose file turns it on, because the whole point of
   * this deployment is to be demonstrated.
   */
  SANDBOX_SIMULATOR_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/**
 * Strict base64 decode.
 *
 * `Buffer.from(value, 'base64')` silently ignores anything it cannot parse, so
 * a 4-character typo decodes to 3 bytes instead of failing - and the error
 * would surface as "key must be 32 bytes" rather than "that is not base64".
 * Re-encoding and comparing is what makes the check mean what it says.
 */
function decodeBase64Key(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');

  // Round-trip. Node's decoder DISCARDS characters it cannot parse rather
  // than failing, so without this a key with a typo in it would decode to a
  // shorter one and the error would say "must be 32 bytes" when the real
  // problem is "that is not base64".
  return decoded.toString('base64') === value ? decoded : null;
}

export type Env = z.infer<typeof envSchema>;

/** Raised when configuration is missing or malformed. Carries per-variable detail. */
export class EnvValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates configuration and returns it typed. Throws `EnvValidationError`.
 * Pure: it takes the source explicitly so it can be unit-tested without
 * mutating the real process environment.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const variable = issue.path.join('.') || '(root)';
      return `${variable}: ${issue.message}`;
    });
    throw new EnvValidationError(problems);
  }

  return result.data;
}

let cached: Env | undefined;

/**
 * Process-level wrapper: validate or terminate.
 *
 * We fail fast and loudly at boot rather than starting a half-configured
 * service that only fails later on a request path. The message names the
 * offending variables; it never prints their values, because a malformed
 * DATABASE_URL still contains a password.
 *
 * Memoised so that `main.ts` (which validates before the Nest container is
 * even built) and the DI provider both see one parse of one environment.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) {
    return cached;
  }

  try {
    cached = parseEnv(source);
    return cached;
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`\n[config] Refusing to start.\n${error.message}\n\n`);
      process.stderr.write(`[config] See .env.example for the full list of variables.\n\n`);
      process.exit(1);
    }
    throw error;
  }
}

/** Test-only: clears the memoised value so each case parses a fresh source. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
