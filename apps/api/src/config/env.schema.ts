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
});

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
