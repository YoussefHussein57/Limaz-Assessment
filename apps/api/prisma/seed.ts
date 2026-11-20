import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { API_KEYS, COMPANIES, EXPECTED, USERS } from './seed/fixtures';
import { seed, type SeedCounts } from './seed/run';

/**
 * CLI entry point for the seed.
 *
 * Run by the API container entrypoint on every start, so `docker compose up`
 * remains the only command a reviewer needs. The work itself lives in
 * seed/run.ts so tests can call it directly.
 *
 * Everything it writes is development-only. See prisma/seed/fixtures.ts.
 */

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The seed is run by the API container entrypoint, ' +
        'or locally with the database reachable on the host port.',
    );
  }
  return url;
}

function verify(counts: SeedCounts): void {
  // The seed checks its own work. A silent partial seed is worse than a loud
  // failure, because the dashboard would simply look wrong.
  const mismatches = Object.entries(EXPECTED).filter(
    ([key, expected]) => counts[key as keyof SeedCounts] !== expected,
  );

  if (mismatches.length > 0) {
    throw new Error(
      `Seed verification failed:\n${mismatches
        .map(([k, v]) => `  ${k}: expected ${v}, found ${counts[k as keyof SeedCounts]}`)
        .join('\n')}`,
    );
  }
}

function report(counts: SeedCounts): void {
  const lines = [
    '',
    '================================================================',
    ' Seed complete - DEVELOPMENT DATA ONLY',
    '================================================================',
    ` companies ${counts.companies}   users ${counts.users}   api keys ${counts.apiKeys}`,
    ` expenses ${counts.expenses}   rule hits ${counts.ruleHits}   reviews ${counts.reviews} (${counts.openReviews} open)`,
    '',
    ' Sign in at http://localhost:3000',
    '',
    ...USERS.map((u) => `   ${u.role.padEnd(15)} ${u.email.padEnd(32)} ${u.password}`),
    '',
    ' Company API keys (header: x-api-key)',
    '',
    ...API_KEYS.map((k) => {
      const company = COMPANIES.find((c) => c.id === k.companyId)!;
      return `   ${company.name.padEnd(20)} ${k.plaintext}`;
    }),
    '',
    ' These credentials are development fixtures. They are published in the',
    ' repository on purpose so a reviewer can run the stack, and they are not',
    ' used anywhere else.',
    '================================================================',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDatabaseUrl(), max: 5 }),
  });

  try {
    const counts = await seed(prisma);
    verify(counts);
    report(counts);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\n[seed] FAILED\n${error instanceof Error ? error.stack : String(error)}\n\n`,
  );
  process.exit(1);
});
