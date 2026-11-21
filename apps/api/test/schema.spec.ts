import type { PrismaClient } from '@prisma/client';
import { createTestPrisma } from './test-db';

/**
 * F01-T01 to F01-T03 - the migration produces the structure the design calls
 * for, on a database that was empty moments ago.
 *
 * These assert on the real catalogue rather than on the Prisma schema file,
 * because the question is what PostgreSQL actually ended up with. Four of the
 * constraints below do not appear in schema.prisma at all - they are appended
 * by hand to the init migration.
 */
describe('F01 database schema', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // --- F01-T01 ---------------------------------------------------------------
  it('F01-T01: migrations applied successfully to a clean database', async () => {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at
        FROM _prisma_migrations
       ORDER BY started_at
    `;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.finished_at !== null)).toBe(true);
    expect(rows.some((r) => r.migration_name.endsWith('_init'))).toBe(true);
  });

  // --- F01-T02 ---------------------------------------------------------------
  it('F01-T02: every required table exists', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const tables = rows.map((r) => r.table_name).sort();

    expect(tables).toEqual(
      expect.arrayContaining([
        'api_keys',
        'companies',
        'expenses',
        'policies',
        'reviews',
        'rule_hits',
        'sessions',
        'users',
      ]),
    );
  });

  it('F01-T02b: every required enum type exists with the expected values', async () => {
    const rows = await prisma.$queryRaw<{ typname: string; labels: string }[]>`
      SELECT t.typname, string_agg(e.enumlabel::text, ',' ORDER BY e.enumsortorder) AS labels
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typnamespace = 'public'::regnamespace
       GROUP BY t.typname
    `;
    const byName = new Map(rows.map((r) => [r.typname, r.labels.split(',')]));

    expect(byName.get('UserRole')).toEqual(['MANAGER', 'PLATFORM_ADMIN']);
    expect(byName.get('ApiKeyStatus')).toEqual(['ACTIVE', 'ROTATING', 'REVOKED']);
    expect(byName.get('ExpenseDecision')).toEqual(['APPROVE', 'REVIEW', 'REJECT']);
    expect(byName.get('ExpenseStatus')).toEqual(['APPROVED', 'REJECTED', 'PENDING_REVIEW']);
    expect(byName.get('ReviewState')).toEqual(['OPEN', 'RESOLVED']);
    expect(byName.get('ReviewOutcome')).toEqual(['APPROVED', 'REJECTED']);
    expect(byName.get('RuleCode')).toEqual(['AMOUNT_LIMIT', 'FREQUENCY', 'BLOCKED_CATEGORY']);
  });

  // --- F01-T03 ---------------------------------------------------------------
  it('F01-T03: the frequency index exists with the columns in the required order', async () => {
    const [row] = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'expenses_companyId_employeeId_spentAt_idx'
    `;

    expect(row).toBeDefined();
    // Order is load-bearing: the range column must come last for the
    // frequency query to be a range scan rather than a filter (ADR-007).
    expect(row!.indexdef).toMatch(/\("companyId", "employeeId", "spentAt"\)/);
  });

  it('F01-T03b: the dashboard, review and credential indexes exist', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const names = rows.map((r) => r.indexname);

    expect(names).toEqual(
      expect.arrayContaining([
        // Manager dashboard: a company's expenses, most recent first.
        'expenses_companyId_spentAt_idx',
        // Manager dashboard: this company's open reviews.
        'reviews_companyId_state_idx',
        // Tenant-scoped idempotency.
        'expenses_companyId_source_externalId_key',
        // Target of the composite foreign key from reviews.
        'expenses_id_companyId_key',
        // Credential lookups.
        'api_keys_keyHash_key',
        'sessions_tokenHash_key',
        // One review per expense.
        'reviews_expenseId_key',
        // A rule fires at most once per expense.
        'rule_hits_expenseId_ruleCode_key',
      ]),
    );
  });

  it('F01-T03c: all five hand-written CHECK constraints are present', async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE contype = 'c' AND connamespace = 'public'::regnamespace
    `;
    const names = rows.map((r) => r.conname);

    expect(names).toEqual(
      expect.arrayContaining([
        'users_role_company_check',
        'expenses_decision_status_check',
        'expenses_amount_non_negative_check',
        'reviews_state_resolution_check',
        'policies_sane_values_check',
      ]),
    );
  });

  it('F01-T03d: the composite foreign key binds a review to its expense AND its tenant', async () => {
    const [row] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = 'reviews_expenseId_companyId_fkey'
    `;

    expect(row).toBeDefined();
    expect(row!.def).toContain('FOREIGN KEY ("expenseId", "companyId")');
    expect(row!.def).toContain('REFERENCES expenses(id, "companyId")');
    // A review must not be deletable out from under an expense, and an expense
    // carrying a review must not vanish.
    expect(row!.def).toContain('ON DELETE RESTRICT');
  });

  it('F01-T03e: expenses and reviews are protected from cascading deletes', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `;
    const byName = new Map(rows.map((r) => [r.conname, r.def]));

    // Financial records and audit records: never removed as a side effect.
    expect(byName.get('expenses_companyId_fkey')).toContain('ON DELETE RESTRICT');
    expect(byName.get('users_companyId_fkey')).toContain('ON DELETE RESTRICT');
    expect(byName.get('reviews_resolvedByUserId_fkey')).toContain('ON DELETE RESTRICT');

    // Records that are meaningless without their parent.
    expect(byName.get('policies_companyId_fkey')).toContain('ON DELETE CASCADE');
    expect(byName.get('api_keys_companyId_fkey')).toContain('ON DELETE CASCADE');
    expect(byName.get('sessions_userId_fkey')).toContain('ON DELETE CASCADE');
    expect(byName.get('rule_hits_expenseId_fkey')).toContain('ON DELETE CASCADE');
  });
});
