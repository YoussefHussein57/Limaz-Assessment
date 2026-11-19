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
