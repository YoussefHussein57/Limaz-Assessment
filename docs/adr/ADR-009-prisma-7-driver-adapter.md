# ADR-009: Prisma 7 with the `pg` driver adapter

- **Status:** Accepted, 2026-11-19 - **implemented in F00**
- **Assessment question:** none (toolchain)
- **Related risks:** R-10

## Context

Prisma was selected as the ORM. During F00 implementation, `prisma generate`
failed with:

```
error: The datasource property `url` is no longer supported in schema files.
Move connection URLs for Migrate to `prisma.config.ts` and pass either
`adapter` for a direct database connection or `accelerateUrl` for Accelerate
to the `PrismaClient` constructor.
Prisma CLI Version : 7.10.1
```

Prisma 7 removed `url` from the `datasource` block. The connection string now
lives in two places with two different consumers:

- the **CLI** (migrate, introspect, generate) reads it from `prisma.config.ts`
- the **runtime client** receives a **driver adapter** object

## Decision

Adopt Prisma **7.10.1** with `@prisma/adapter-pg`.

`prisma.config.ts`:

```ts
import { defineConfig, env } from 'prisma/config';

try {
  process.loadEnvFile('.env');
} catch {
  // No local .env - fall through to the ambient environment (Docker, CI).
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
  migrations: { path: 'prisma/migrations' },
});
```

`PrismaService`:

```ts
constructor(@Inject(ENV) env: Env) {
  super({
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
    }),
  });
}
```

## Alternatives considered

| Option | Verdict |
|---|---|
| **Prisma 7.10.1 with `@prisma/adapter-pg`** | **Chosen** |
| Prisma 8.0.0-rc.34 | Rejected: release candidate. An assessment submission should not depend on pre-release software. |
| Downgrade to Prisma 6.19.3 | Rejected: `url = env(...)` still works there, but it means shipping a major version behind on day one to avoid a migration that took under an hour and produced a concrete benefit (below). |

## Why the adapter is an advantage, not a chore

The adapter takes a `pg.PoolConfig`, which means **the connection pool is now
explicit and configurable** rather than an implicit Prisma default.

This matters directly for risk **R-10**: a concurrency test whose pool is
smaller than its concurrency is serialised by the pool itself and passes without
testing anything. With the adapter, `DB_POOL_MAX` is a validated environment
variable (ADR-007), visible in `.env.example`, asserted at boot, and pinned to
`10` in the test setup.

Under Prisma 6 the pool size was buried in a connection-string parameter and far
easier to get wrong silently.

## Consequences

- `prisma/schema.prisma` has a `datasource` block with a `provider` and **no
  `url`**. This looks wrong to anyone familiar with Prisma 6, so the file
  carries a comment explaining it.
- `prisma.config.ts` is a new required file. Losing it breaks every CLI command,
  including `migrate deploy` in the container entrypoint.
- Prisma 7 no longer auto-loads `.env`. `process.loadEnvFile` (built into
  Node 20.12+) is used rather than adding a `dotenv` dependency.
- `pg` and `@types/pg` arrive as dependencies of `@prisma/adapter-pg`.

## Verification performed in F00

- `prisma generate` succeeds against a schema with **zero models**, producing a
  client usable for `$queryRaw`.
- The API connects on boot and `GET /health` reports
  `{"database":{"status":"up","latencyMs":2.57}}` against a real PostgreSQL 17
  container.
- `apps/api/test/health.e2e-spec.ts` passes against that container.

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| `prisma.config.ts` missing or misnamed | Every CLI command fails, including container-start migrations | F00-T01 starts the stack through the real entrypoint |
| `DATABASE_URL` absent at CLI time | `migrate deploy` fails inside the container | Entrypoint runs migrations before the app starts, so the container fails loudly rather than serving traffic |
| Pool exhausted under load | Requests queue, then time out | `DB_POOL_MAX` is explicit, validated and documented |
