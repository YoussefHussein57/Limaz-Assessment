import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/**
 * =============================================================================
 * DEVELOPMENT FIXTURES
 * =============================================================================
 *
 * Every `decision`, `status`, `ruleHits` and `policySnapshot` value in this
 * file is WRITTEN BY HAND. The policy engine does not exist yet - it is built
 * in F04 - so these are not produced by the system under test.
 *
 * That is a real limitation, and it is handled rather than hidden: F04 adds a
 * regression test that feeds these same inputs through the real policy engine
 * and asserts it produces exactly the decisions recorded here. If the engine
 * and these fixtures ever disagree, that test fails. The limitation becomes a
 * guarantee instead of a note in a README.
 *
 * CREDENTIALS IN THIS FILE ARE DEVELOPMENT-ONLY. They exist so a reviewer can
 * log in to a local stack. They are not, and have never been, real. Production
 * credentials come from the deployment platform's secret store.
 * =============================================================================
 */

/**
 * Deterministic ids. The seed upserts by id, so re-running it updates the same
 * rows instead of inserting new ones - which is what makes it idempotent.
 * Random ids would make a second run double the data.
 *
 * Shaped like UUIDv7 (version nibble 7, variant nibble 8) to match the ids the
 * application generates at runtime.
 */
function fixedId(group: string, n: number): string {
  return `0193f0${group}-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

const COMPANY = (n: number) => fixedId('c0', n);
const POLICY = (n: number) => fixedId('c1', n);
const USER = (n: number) => fixedId('c2', n);
const API_KEY = (n: number) => fixedId('c3', n);
const EXPENSE = (n: number) => fixedId('e0', n);
const RULE_HIT = (n: number) => fixedId('e1', n);
const REVIEW = (n: number) => fixedId('e2', n);

/** Fixed base instant so every seeded timestamp is reproducible. */
const BASE = new Date('2026-11-18T09:00:00.000Z').getTime();
const at = (minutes: number): Date => new Date(BASE + minutes * 60_000);

/**
 * The same canonicalisation the API will use in F03: sorted keys, normalised
 * timestamp, SHA-256. Written here so the seeded rows carry real hashes rather
 * than placeholders. F03 asserts that its implementation agrees with these.
 */
export function payloadHash(input: {
  employeeId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  category: string;
  spentAt: Date;
}): string {
  const canonical = JSON.stringify({
    amountMinor: input.amountMinor,
    category: input.category,
    currency: input.currency,
    employeeId: input.employeeId,
    merchant: input.merchant,
    spentAt: input.spentAt.toISOString(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// -----------------------------------------------------------------------------
// Companies and policies - deliberately different settings (assessment s4)
// -----------------------------------------------------------------------------

export interface CompanyFixture {
  id: string;
  name: string;
  currency: string;
  policy: {
    id: string;
    autoApproveLimitMinor: number;
    frequencyMaxCount: number;
    frequencyWindowMinutes: number;
    blockedCategories: string[];
  };
}

export const COMPANY_A: CompanyFixture = {
  id: COMPANY(1),
  name: 'Nile Logistics',
  currency: 'SAR',
  policy: {
    id: POLICY(1),
    autoApproveLimitMinor: 50_000, // 500.00 SAR
    frequencyMaxCount: 3,
    frequencyWindowMinutes: 60,
    blockedCategories: ['GAMBLING'],
  },
};

export const COMPANY_B: CompanyFixture = {
  id: COMPANY(2),
  name: 'Delta Consulting',
  currency: 'SAR',
  policy: {
    id: POLICY(2),
    autoApproveLimitMinor: 200_000, // 2000.00 SAR - four times company A
    frequencyMaxCount: 5, // and a different frequency rule
    frequencyWindowMinutes: 30,
    blockedCategories: ['ALCOHOL', 'GAMBLING'],
  },
};

export const COMPANIES = [COMPANY_A, COMPANY_B];

// -----------------------------------------------------------------------------
// Users - DEVELOPMENT-ONLY credentials
// -----------------------------------------------------------------------------

export interface UserFixture {
  id: string;
  companyId: string | null;
  email: string;
  displayName: string;
  role: 'MANAGER' | 'PLATFORM_ADMIN';
  /** Development-only. Hashed with bcrypt before it reaches the database. */
  password: string;
}

export const USERS: UserFixture[] = [
  {
    id: USER(1),
    companyId: COMPANY_A.id,
    email: 'manager@nile-logistics.test',
    displayName: 'Nour Hassan',
    role: 'MANAGER',
    password: 'NileManager!2026',
  },
  {
    id: USER(2),
    companyId: COMPANY_B.id,
    email: 'manager@delta-consulting.test',
    displayName: 'Omar Fathy',
    role: 'MANAGER',
    password: 'DeltaManager!2026',
  },
  {
    // The platform admin belongs to no company. The users_role_company_check
    // constraint requires companyId to be null for exactly this role.
    id: USER(3),
    companyId: null,
    email: 'admin@limaz.test',
    displayName: 'Platform Admin',
    role: 'PLATFORM_ADMIN',
    password: 'PlatformAdmin!2026',
  },
];

// -----------------------------------------------------------------------------
// API keys - DEVELOPMENT-ONLY
// -----------------------------------------------------------------------------

export interface ApiKeyFixture {
  id: string;
  companyId: string;
  /** Development-only plaintext. Only its SHA-256 hash is stored (ADR-006). */
  plaintext: string;
}

export const API_KEYS: ApiKeyFixture[] = [
  {
    id: API_KEY(1),
    companyId: COMPANY_A.id,
    plaintext: 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s',
  },
  {
    id: API_KEY(2),
    companyId: COMPANY_B.id,
    plaintext: 'lmz_dev_delta_3Xn9TbVcA7pKmR2wQy8ZsL4dHe6uJ5g',
  },
];

// -----------------------------------------------------------------------------
// Expenses - hand-written decisions, see the header note
// -----------------------------------------------------------------------------

export interface RuleHitFixture {
  id: string;
  ruleCode: 'AMOUNT_LIMIT' | 'FREQUENCY' | 'BLOCKED_CATEGORY';
  decision: 'APPROVE' | 'REVIEW' | 'REJECT';
  detail: Prisma.InputJsonObject;
}

export interface ReviewFixture {
  id: string;
  state: 'OPEN' | 'RESOLVED';
  outcome: 'APPROVED' | 'REJECTED' | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
}

export interface ExpenseFixture {
  id: string;
  companyId: string;
  externalId: string;
  employeeId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  category: string;
  spentAt: Date;
  decision: 'APPROVE' | 'REVIEW' | 'REJECT';
  status: 'APPROVED' | 'REJECTED' | 'PENDING_REVIEW';
  ruleHits: RuleHitFixture[];
  review: ReviewFixture | null;
}

/** The policy settings each expense was judged against (assumption A7). */
export function snapshotOf(company: CompanyFixture): Prisma.InputJsonObject {
  return {
    autoApproveLimitMinor: company.policy.autoApproveLimitMinor,
    frequencyMaxCount: company.policy.frequencyMaxCount,
    frequencyWindowMinutes: company.policy.frequencyWindowMinutes,
    blockedCategories: company.policy.blockedCategories,
    capturedBy: 'DEVELOPMENT FIXTURE - not produced by the policy engine',
  };
}

export const EXPENSES: ExpenseFixture[] = [
  // --- Company A: three approvals, then the fourth trips the frequency rule ---
  {
    id: EXPENSE(1),
    companyId: COMPANY_A.id,
    externalId: 'exp-1001',
    employeeId: 'emp-7',
    amountMinor: 12_500,
    currency: 'SAR',
    merchant: 'City Taxi',
    category: 'TRANSPORT',
    spentAt: at(0),
    decision: 'APPROVE',
    status: 'APPROVED',
    ruleHits: [],
    review: null,
  },
  {
    id: EXPENSE(2),
    companyId: COMPANY_A.id,
    externalId: 'exp-1002',
    employeeId: 'emp-7',
    amountMinor: 12_000,
    currency: 'SAR',
    merchant: 'Beans Cafe',
    category: 'FOOD',
    spentAt: at(10),
    decision: 'APPROVE',
    status: 'APPROVED',
    ruleHits: [],
    review: null,
  },
  {
    id: EXPENSE(3),
    companyId: COMPANY_A.id,
    externalId: 'exp-1003',
    employeeId: 'emp-7',
    amountMinor: 9_000,
    currency: 'SAR',
    merchant: 'Beans Cafe',
    category: 'FOOD',
    spentAt: at(20),
    decision: 'APPROVE',
    // Three in the window is not "more than 3" - this one still passes.
    status: 'APPROVED',
    ruleHits: [],
    review: null,
  },
  {
    id: EXPENSE(4),
    companyId: COMPANY_A.id,
    externalId: 'exp-1004',
    employeeId: 'emp-7',
    amountMinor: 8_000,
    currency: 'SAR',
    merchant: 'City Taxi',
    category: 'TRANSPORT',
    spentAt: at(30),
    // Window [at(-30), at(30)] holds exp-1001, 1002, 1003 and this one: 4 > 3.
    decision: 'REVIEW',
    status: 'PENDING_REVIEW',
    ruleHits: [
      {
        id: RULE_HIT(1),
        ruleCode: 'FREQUENCY',
        decision: 'REVIEW',
        detail: { windowMinutes: 60, maxCount: 3, countIncludingCurrent: 4 },
      },
    ],
    // Left OPEN on purpose, so the manager dashboard has work to show.
    review: { id: REVIEW(1), state: 'OPEN', outcome: null, resolvedByUserId: null, resolvedAt: null },
  },

  // --- Company A: over the limit, reviewed and approved by the manager ---
  {
    id: EXPENSE(5),
    companyId: COMPANY_A.id,
    externalId: 'exp-1005',
    employeeId: 'emp-9',
    amountMinor: 125_000, // 1250.00 SAR, over the 500.00 limit
    currency: 'SAR',
    merchant: 'Jarir Bookstore',
    category: 'EQUIPMENT',
    spentAt: at(60),
    decision: 'REVIEW',
    // Resolved APPROVED, so the final status moved while the decision did not.
    status: 'APPROVED',
    ruleHits: [
      {
        id: RULE_HIT(2),
        ruleCode: 'AMOUNT_LIMIT',
        decision: 'REVIEW',
        detail: { autoApproveLimitMinor: 50_000, amountMinor: 125_000 },
      },
    ],
    review: {
      id: REVIEW(2),
      state: 'RESOLVED',
      outcome: 'APPROVED',
      resolvedByUserId: USER(1),
      resolvedAt: at(90),
    },
  },

  // --- Company A: blocked category, rejected outright, no review opened ---
  {
    id: EXPENSE(6),
    companyId: COMPANY_A.id,
    externalId: 'exp-1006',
    employeeId: 'emp-9',
    amountMinor: 30_000,
    currency: 'SAR',
    merchant: 'Casino Royale',
    category: 'GAMBLING',
    spentAt: at(120),
    decision: 'REJECT',
    status: 'REJECTED',
    ruleHits: [
      {
        id: RULE_HIT(3),
        ruleCode: 'BLOCKED_CATEGORY',
        decision: 'REJECT',
        detail: { category: 'GAMBLING', blockedCategories: ['GAMBLING'] },
      },
    ],
    review: null,
  },

  // --- Company A: TWO rules fire. REJECT beats REVIEW, both are reported ---
  {
    id: EXPENSE(7),
    companyId: COMPANY_A.id,
    externalId: 'exp-1007',
    employeeId: 'emp-3',
    amountMinor: 80_000, // over the limit AND a blocked category
    currency: 'SAR',
    merchant: 'Casino Royale',
    category: 'GAMBLING',
    spentAt: at(180),
    decision: 'REJECT',
    status: 'REJECTED',
    ruleHits: [
      {
        id: RULE_HIT(4),
        ruleCode: 'AMOUNT_LIMIT',
        decision: 'REVIEW',
        detail: { autoApproveLimitMinor: 50_000, amountMinor: 80_000 },
      },
      {
        id: RULE_HIT(5),
        ruleCode: 'BLOCKED_CATEGORY',
        decision: 'REJECT',
        detail: { category: 'GAMBLING', blockedCategories: ['GAMBLING'] },
      },
    ],
    review: null,
  },
  {
    id: EXPENSE(8),
    companyId: COMPANY_A.id,
    externalId: 'exp-1008',
    employeeId: 'emp-3',
    amountMinor: 20_000,
    currency: 'SAR',
    merchant: 'JetBrains',
    category: 'SOFTWARE',
    spentAt: at(240),
    decision: 'APPROVE',
    status: 'APPROVED',
    ruleHits: [],
    review: null,
  },

  // --- Company B ---
  {
    // DELIBERATELY the same externalId as company A's first expense. Both rows
    // coexist, which is what tenant-scoped uniqueness means (test F01-T05).
    id: EXPENSE(9),
    companyId: COMPANY_B.id,
    externalId: 'exp-1001',
    employeeId: 'emp-21',
    amountMinor: 45_000,
    currency: 'SAR',
    merchant: 'Careem',
    category: 'TRANSPORT',
    spentAt: at(0),
    decision: 'APPROVE',
    status: 'APPROVED',
    ruleHits: [],
    review: null,
  },
  {
    // Over company B's higher limit, reviewed and REJECTED by its manager.
    id: EXPENSE(10),
    companyId: COMPANY_B.id,
    externalId: 'exp-2002',
    employeeId: 'emp-21',
    amountMinor: 350_000, // 3500.00 SAR, over the 2000.00 limit
    currency: 'SAR',
    merchant: 'Saudia',
    category: 'TRAVEL',
    spentAt: at(60),
    decision: 'REVIEW',
    status: 'REJECTED',
    ruleHits: [
      {
        id: RULE_HIT(6),
        ruleCode: 'AMOUNT_LIMIT',
        decision: 'REVIEW',
        detail: { autoApproveLimitMinor: 200_000, amountMinor: 350_000 },
      },
    ],
    review: {
      id: REVIEW(3),
      state: 'RESOLVED',
      outcome: 'REJECTED',
      resolvedByUserId: USER(2),
      resolvedAt: at(100),
    },
  },
  {
    // ALCOHOL is blocked for company B but NOT for company A - the same
    // expense would be judged differently by the two policies.
    id: EXPENSE(11),
    companyId: COMPANY_B.id,
    externalId: 'exp-2003',
    employeeId: 'emp-22',
    amountMinor: 60_000,
    currency: 'SAR',
    merchant: 'Duty Free',
    category: 'ALCOHOL',
    spentAt: at(120),
    decision: 'REJECT',
    status: 'REJECTED',
    ruleHits: [
      {
        id: RULE_HIT(7),
        ruleCode: 'BLOCKED_CATEGORY',
        decision: 'REJECT',
        detail: { category: 'ALCOHOL', blockedCategories: ['ALCOHOL', 'GAMBLING'] },
      },
    ],
    review: null,
  },
  {
    id: EXPENSE(12),
    companyId: COMPANY_B.id,
    externalId: 'exp-2004',
    employeeId: 'emp-22',
    amountMinor: 15_000,
    currency: 'SAR',
    merchant: 'Beans Cafe',
    category: 'FOOD',
    spentAt: at(180),
    decision: 'APPROVE',
    status: 'APPROVED',
    ruleHits: [],
    review: null,
  },
];

/** Expected totals, asserted by the seed itself and by tests F01-T13 to T16. */
export const EXPECTED = {
  companies: 2,
  policies: 2,
  users: 3,
  apiKeys: 2,
  expenses: EXPENSES.length,
  ruleHits: EXPENSES.reduce((n, e) => n + e.ruleHits.length, 0),
  reviews: EXPENSES.filter((e) => e.review !== null).length,
  openReviews: EXPENSES.filter((e) => e.review?.state === 'OPEN').length,
} as const;
