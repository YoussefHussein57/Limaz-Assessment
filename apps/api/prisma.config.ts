import { defineConfig } from 'prisma/config';

// Prisma 7 no longer auto-loads `.env`. Node's built-in loader is used so the
// CLI does not need a `dotenv` dependency of its own. In Docker and CI the
// variables are already in the environment and there is no file to load.
try {
  process.loadEnvFile('.env');
} catch {
  // No local .env - fall through to the ambient environment.
}

const databaseUrl = process.env.DATABASE_URL;

/**
 * The datasource is attached only when DATABASE_URL is actually present.
 *
 * `prisma generate` needs no connection - it reads the schema and emits a
 * client - but Prisma's `env()` helper resolves eagerly at config load and
 * throws `PrismaConfigEnvError` when the variable is missing. That turns
 * image builds, which deliberately carry no database credentials, into a
 * build failure.
 *
 * Commands that genuinely need the URL (`migrate deploy`, `migrate dev`,
 * `db pull`) run from the container entrypoint or a developer shell, where
 * DATABASE_URL is always set. If one is ever run without it, Prisma reports a
 * missing datasource, which is the correct and legible failure.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
  migrations: {
    path: 'prisma/migrations',
  },
});
