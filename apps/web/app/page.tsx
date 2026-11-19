import { serverFetch } from '@/lib/api';

/**
 * F00 placeholder. Its one job is to prove the wiring is real: the page is
 * rendered by the Next server, which reaches the NestJS service over the
 * Docker network and reports what came back.
 *
 * The manager dashboard replaces this in F06.
 */
export const dynamic = 'force-dynamic';

interface HealthResponse {
  status: string;
  uptimeSeconds: number;
  checks: { database: { status: string; latencyMs?: number } };
}

export default async function HomePage() {
  const health = await serverFetch<HealthResponse>('/health');
  const database = health.data?.checks?.database;
  const reachable = health.ok && database?.status === 'up';

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">LIMAZ Expense Policy</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Foundation (F00). The manager dashboard and admin panel are not built yet.
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 p-5 dark:border-slate-800">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-slate-500">
          Backend connectivity
        </h2>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">API</dt>
          <dd>{health.ok ? 'reachable' : 'unreachable'}</dd>

          <dt className="text-slate-500">Database</dt>
          <dd>{database?.status ?? 'unknown'}</dd>

          {typeof database?.latencyMs === 'number' && (
            <>
              <dt className="text-slate-500">Latency</dt>
              <dd>{database.latencyMs} ms</dd>
            </>
          )}
        </dl>

        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
          {reachable
            ? 'The web server reached the API and the API reached PostgreSQL.'
            : 'The web server could not confirm a healthy API. Check `docker compose ps`.'}
        </p>
      </section>
    </main>
  );
}
