#!/usr/bin/env node
/**
 * Runs every black-box QA cycle against a RUNNING stack and prints one summary.
 *
 * These are not the unit or integration suites. Those run against a throwaway
 * database and prove the mechanisms. This runs against the real stack over
 * HTTP, exactly as a company backend, a manager's browser and a card provider
 * reach it - so it also proves the wiring between them.
 *
 *   docker compose up -d
 *   node scripts/qa-cycles/run-all.mjs
 *
 * It writes to the development database. Every row it creates is namespaced
 * with a per-run id, so repeated runs do not collide; `docker compose down -v`
 * clears them.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const CYCLES = [
  ['1-3', 'health, authentication, tenant isolation', 'cycle-1-3-auth-and-tenancy.mjs'],
  ['4-6', 'submission validation, idempotency, policy', 'cycle-4-6-submission-and-policy.mjs'],
  ['7-9', 'reviews, dashboard and listing, settings', 'cycle-7-9-reviews-and-settings.mjs'],
  ['10', 'platform administration', 'cycle-10-administration.mjs'],
  ['11-12', 'card webhook and the sandbox simulator', 'cycle-11-12-webhook-and-simulator.mjs'],
];

const summary = [];
let failed = 0;

for (const [id, name, file] of CYCLES) {
  console.log(`\n=================  CYCLE ${id}  ${name}  =================\n`);
  const run = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    env: process.env,
  });
  const ok = run.status === 0;
  if (!ok) failed += 1;
  summary.push(`  ${ok ? 'PASS' : 'FAIL'}  cycle ${id.padEnd(5)} ${name}`);
}

console.log('\n=================  SUMMARY  =================\n');
console.log(summary.join('\n'));
console.log(
  `\n${CYCLES.length - failed}/${CYCLES.length} cycles passed.\n` +
    'A cycle fails on the FIRST unexpected result, so read the FAILURES block it printed.\n',
);

process.exit(failed ? 1 : 0);
