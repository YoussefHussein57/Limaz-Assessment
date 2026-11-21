#!/usr/bin/env node
/**
 * Regenerates docs/testing/F11-F12-test-matrix.md from a Jest run.
 *
 * =============================================================================
 * WHY THIS MATRIX IS GENERATED AND THE OTHERS ARE NOT
 * =============================================================================
 *
 * The F00-F09 matrices were written by hand, and one of them was WRONG for six
 * features: `verify-f00.sh` had been failing since F02.1 while every report
 * quoted the two scripts that passed (AI_LOG 45).
 *
 * A matrix typed by hand records what somebody believed. This one records what
 * the runner actually did - every case, with the status it was given. If a
 * test is deleted, renamed or starts failing, this file changes.
 *
 * Usage:
 *   npm test --workspace @limaz/api -- --json --outputFile=report.json
 *   node scripts/make-test-matrix.mjs report.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SUITES = [
  [
    'manager-provisioning.e2e-spec.ts',
    'F11 - manager provisioning',
    'real PostgreSQL, real HTTP, the review lifecycle wired in',
  ],
  [
    'webhook-crypto.spec.ts',
    'F12 - cryptographic primitives',
    'unit, no database. The HMAC is checked against an independent implementation',
  ],
  [
    'webhook-intake.e2e-spec.ts',
    'F12 - signature verification and durable acceptance',
    'real PostgreSQL, real HTTP, the body signed and sent as one string',
  ],
  [
    'webhook-worker.e2e-spec.ts',
    'F12 - asynchronous processing and recovery',
    'real PostgreSQL, the worker driven one event at a time rather than slept on',
  ],
  [
    'simulator.e2e-spec.ts',
    'F12 - the sandbox simulator',
    'real PostgreSQL on a real listening port, so the simulator posts over HTTP',
  ],
];

const reportPath = process.argv[2];
const outPath = process.argv[3] ?? 'docs/testing/F11-F12-test-matrix.md';

if (!reportPath) {
  process.stderr.write('usage: node scripts/make-test-matrix.mjs <jest-report.json> [out.md]\n');
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const lines = [
  '# F11 and F12 - test matrix',
  '',
  '**Generated from the Jest report, never typed by hand.** Every row is a case',
  'that ran, with the status the runner gave it. Regenerate with:',
  '',
  '```bash',
  'npm test --workspace @limaz/api -- --json --outputFile=report.json',
  'node scripts/make-test-matrix.mjs report.json',
  '```',
  '',
  'The hand-written matrices for F00-F09 record what I believed. This one',
  'records what happened - which matters, because one hand-written matrix was',
  'wrong for six features (AI_LOG 45).',
  '',
];

let total = 0;
let passed = 0;

for (const [file, title, kind] of SUITES) {
  const suite = report.testResults.find((r) => r.name.replace(/\\/gu, '/').endsWith(`/${file}`));

  if (!suite) {
    lines.push(`## ${title}`, '', `**\`${file}\` was not in this report.**`, '');
    continue;
  }

  lines.push(`## ${title}`, '', `\`${file}\` — ${kind}`, '');
  lines.push('| Case | What it asserts | Result |', '|---|---|---|');

  for (const result of suite.assertionResults) {
    total += 1;
    if (result.status === 'passed') passed += 1;

    const name = result.title ?? '';
    const at = name.indexOf(': ');
    const id = at === -1 ? '-' : name.slice(0, at);
    const what = (at === -1 ? name : name.slice(at + 2)).replace(/\|/gu, '\\|');
    const mark = result.status === 'passed' ? '**PASS**' : `**${result.status.toUpperCase()}**`;

    lines.push(`| ${id} | ${what} | ${mark} |`);
  }

  lines.push('');
}

lines.push('---', '', `## Total: ${passed} / ${total}`, '');

if (passed !== total) {
  lines.push(`**${total - passed} did not pass**, and are marked above.`, '');
}

writeFileSync(outPath, lines.join('\n'));
process.stdout.write(`${outPath}: ${passed}/${total}\n`);
