import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { API_KEYS, COMPANIES, EXPENSES, USERS, payloadHash, snapshotOf } from './fixtures';

/**
 * The seed itself, separated from the CLI entry point so tests can run it
 * against a throwaway database without spawning a process or tripping over
 * `process.exit`.
 *
 * IDEMPOTENT BY CONSTRUCTION: every write is an `upsert` keyed on a fixed id
 * from fixtures.ts. Running it twice produces exactly the same rows, which is
 * what lets the container entrypoint run it on every start without the data
 * doubling (test F01-T15).
 *
 * The whole seed runs in one transaction. A partial seed could leave an
 * expense with a REVIEW decision and no review row - a state the dashboard
 * and test F01-T16 both treat as corrupt.
 */

const BCRYPT_COST = 10;

export interface SeedCounts {
  companies: number;
  policies: number;
  users: number;
  apiKeys: number;
  expenses: number;
  ruleHits: number;
  reviews: number;
  openReviews: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** First 16 characters, for display in the admin panel only (ADR-006). */
export function prefixOf(key: string): string {
  return key.slice(0, 16);
}

export async function seed(prisma: PrismaClient): Promise<SeedCounts> {
  // Hashing happens before the transaction: bcrypt is deliberately slow, and
  // holding a transaction open across three of them is pointless.
  const passwordHashes = new Map<string, string>();
  for (const user of USERS) {
    passwordHashes.set(user.id, await bcrypt.hash(user.password, BCRYPT_COST));
  }

  await prisma.$transaction(
    async (tx) => {
      for (const company of COMPANIES) {
        await tx.company.upsert({
          where: { id: company.id },
          create: { id: company.id, name: company.name, currency: company.currency },
          update: { name: company.name, currency: company.currency },
        });

        await tx.policy.upsert({
          where: { id: company.policy.id },
          create: { ...company.policy, companyId: company.id },
          update: {
            autoApproveLimitMinor: company.policy.autoApproveLimitMinor,
            frequencyMaxCount: company.policy.frequencyMaxCount,
            frequencyWindowMinutes: company.policy.frequencyWindowMinutes,
            blockedCategories: company.policy.blockedCategories,
          },
        });
      }

      for (const user of USERS) {
        const hash = passwordHashes.get(user.id)!;
        await tx.user.upsert({
          where: { id: user.id },
          create: {
            id: user.id,
            companyId: user.companyId,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            passwordHash: hash,
          },
          // Rewritten on every run so the seed always restores the documented
          // password, even if someone changed it locally.
          update: { displayName: user.displayName, role: user.role, passwordHash: hash },
        });
      }

      for (const key of API_KEYS) {
        // Only the hash is stored. The plaintext never reaches the database.
        const keyHash = sha256(key.plaintext);
        await tx.apiKey.upsert({
          where: { id: key.id },
          create: {
            id: key.id,
            companyId: key.companyId,
            keyHash,
            prefix: prefixOf(key.plaintext),
            status: 'ACTIVE',
          },
          update: { keyHash, prefix: prefixOf(key.plaintext), status: 'ACTIVE' },
        });
      }

      for (const expense of EXPENSES) {
        const company = COMPANIES.find((c) => c.id === expense.companyId)!;

        const fields = {
          companyId: expense.companyId,
          externalId: expense.externalId,
          employeeId: expense.employeeId,
          amountMinor: expense.amountMinor,
          currency: expense.currency,
          merchant: expense.merchant,
          category: expense.category,
          spentAt: expense.spentAt,
          receivedAt: expense.spentAt,
          decision: expense.decision,
          status: expense.status,
          payloadHash: payloadHash(expense),
          policySnapshot: snapshotOf(company),
        };

        await tx.expense.upsert({
          where: { id: expense.id },
          create: { id: expense.id, ...fields },
          update: fields,
        });

        for (const hit of expense.ruleHits) {
          await tx.ruleHit.upsert({
            where: { expenseId_ruleCode: { expenseId: expense.id, ruleCode: hit.ruleCode } },
            create: {
              id: hit.id,
              expenseId: expense.id,
              ruleCode: hit.ruleCode,
              decision: hit.decision,
              detail: hit.detail,
            },
            update: { decision: hit.decision, detail: hit.detail },
          });
        }

        if (expense.review) {
          const review = expense.review;
          await tx.review.upsert({
            where: { id: review.id },
            create: {
              id: review.id,
              expenseId: expense.id,
              // Taken from the expense, never invented. The composite foreign
              // key would reject any other value anyway (assumption A9).
              companyId: expense.companyId,
              state: review.state,
              outcome: review.outcome,
              resolvedByUserId: review.resolvedByUserId,
              resolvedAt: review.resolvedAt,
              // A review is opened WHEN THE EXPENSE IS SUBMITTED, so it is
              // stamped from the expense rather than left to default to
              // now(). Without this the seeded reviews are "opened" at
              // whenever the container last started - which is AFTER the
              // fixture resolution timestamps, so the expense detail page
              // showed a review resolved before it was opened. Caught by
              // reading the real page, not by a test.
              createdAt: expense.spentAt,
            },
            update: {
              state: review.state,
              outcome: review.outcome,
              resolvedByUserId: review.resolvedByUserId,
              resolvedAt: review.resolvedAt,
              createdAt: expense.spentAt,
            },
          });
        }
      }
    },
    { timeout: 60_000 },
  );

  // ---------------------------------------------------------------------
  // Counted BY FIXTURE ID, not across the whole table.
  //
  // The point of this count is for the seed to check its own work: did every
  // upsert land, and did none of them double? Counting whole tables answered
  // a different question - "is this database untouched?" - and that made the
  // stack refuse to restart as soon as anybody used it. The README invites a
  // reviewer to POST an expense with curl; the next `docker compose up` then
  // died with "expenses: expected 12, found 13" and the API container went
  // into a restart loop, with nothing saying the extra row was theirs
  // (AI_LOG 49).
  //
  // Scoped to the fixture ids, the guard still catches a partial or doubled
  // seed, and application data is simply none of its business.
  // ---------------------------------------------------------------------
  const expenseIds = EXPENSES.map((e) => e.id);
  const reviewIds = EXPENSES.flatMap((e) => (e.review ? [e.review.id] : []));

  return {
    companies: await prisma.company.count({ where: { id: { in: COMPANIES.map((c) => c.id) } } }),
    policies: await prisma.policy.count({
      where: { id: { in: COMPANIES.map((c) => c.policy.id) } },
    }),
    users: await prisma.user.count({ where: { id: { in: USERS.map((u) => u.id) } } }),
    apiKeys: await prisma.apiKey.count({ where: { id: { in: API_KEYS.map((k) => k.id) } } }),
    expenses: await prisma.expense.count({ where: { id: { in: expenseIds } } }),
    // By owning expense, not by id: rule hits are upserted on
    // `(expenseId, ruleCode)`, so that is the invariant the seed maintains.
    ruleHits: await prisma.ruleHit.count({ where: { expenseId: { in: expenseIds } } }),
    reviews: await prisma.review.count({ where: { id: { in: reviewIds } } }),
    openReviews: await prisma.review.count({ where: { id: { in: reviewIds }, state: 'OPEN' } }),
  };
}
