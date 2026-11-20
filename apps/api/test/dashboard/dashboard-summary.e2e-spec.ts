import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  API_KEYS,
  COMPANY_A,
  COMPANY_B,
  EXPENSES,
  USERS,
  type ExpenseFixture,
} from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { PasswordService } from '../../src/auth/password.service';
import { resetDatabase } from '../test-db';
import { asManager, createF06TestApp, login, TEST_APP_ORIGIN } from './f06-test-app';

/**
 * F06-T01 to T05, T10 - the dashboard aggregate.
 *
 * The expected figures are DERIVED from the seed fixtures rather than typed
 * in. A hard-coded `5` passes for the wrong reason the day somebody adds a
 * seeded expense, and the failure would read as a dashboard bug.
 */
describe('F06 dashboard summary', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const deltaManager = USERS.find((u) => u.companyId === COMPANY_B.id)!;
  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  let nileCookie: string;
  let deltaCookie: string;
  let adminCookie: string;

  /** What the fixtures say a company's dashboard must show. */
  const expected = (companyId: string) => {
    const mine: ExpenseFixture[] = EXPENSES.filter((e) => e.companyId === companyId);
    const flagged = mine.filter((e) => e.decision === 'REVIEW');

    return {
      total: mine.length,
      byStatus: {
        APPROVED: mine.filter((e) => e.status === 'APPROVED').length,
        REJECTED: mine.filter((e) => e.status === 'REJECTED').length,
        PENDING_REVIEW: mine.filter((e) => e.status === 'PENDING_REVIEW').length,
      },
      flagged: {
        total: flagged.length,
        pending: flagged.filter((e) => e.status === 'PENDING_REVIEW').length,
        approvedByManager: flagged.filter((e) => e.status === 'APPROVED').length,
        rejectedByManager: flagged.filter((e) => e.status === 'REJECTED').length,
      },
      totalMinor: mine.reduce((sum, e) => sum + e.amountMinor, 0),
    };
  };

  beforeAll(async () => {
    const booted = await createF06TestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    nileCookie = await login(app, nileManager.email, nileManager.password);
    deltaCookie = await login(app, deltaManager.email, deltaManager.password);
    adminCookie = await login(app, admin.email, admin.password);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  // --- F06-T01: correct own-company counts --------------------------------
  it('F06-T01: a manager sees their own company counts', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(nileCookie))
      .expect(200);

    const want = expected(COMPANY_A.id);

    expect(response.body.total).toBe(want.total);
    expect(response.body.byStatus).toEqual(want.byStatus);
    expect(response.body.amounts).toEqual([{ currency: 'SAR', totalMinor: want.totalMinor }]);
  });

  it('F06-T01b: the status counts sum to the total', async () => {
    // Not a restatement of T01. This is the property the single `groupBy`
    // exists to guarantee: four separate count() calls would be four
    // snapshots and could disagree. Asserted on the RESPONSE, so it holds
    // for whatever the fixtures happen to contain.
    const response = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(nileCookie))
      .expect(200);

    const { APPROVED, REJECTED, PENDING_REVIEW } = response.body.byStatus;

    expect(APPROVED + REJECTED + PENDING_REVIEW).toBe(response.body.total);
  });

  // --- F06-T02: a company with no expenses --------------------------------
  it('F06-T02: a company with no expenses gets zeros, not nulls', async () => {
    const empty = await prisma.company.create({
      data: {
        name: 'Empty Co',
        currency: 'SAR',
        policy: { create: { autoApproveLimitMinor: 50_000, blockedCategories: [] } },
      },
    });

    const passwords = app.get(PasswordService);
    const password = `Test-empty-${Math.random().toString(36).slice(2, 12)}`;

    await prisma.user.create({
      data: {
        email: 'empty-co@test.invalid',
        companyId: empty.id,
        role: 'MANAGER',
        displayName: 'Empty Manager',
        passwordHash: await passwords.hash(password),
      },
    });

    const cookie = await login(app, 'empty-co@test.invalid', password);

    const response = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(cookie))
      .expect(200);

    expect(response.body.total).toBe(0);
    // All three keys present and zero. An absent key would render as "—" in
    // the UI and read as "unknown" rather than "none".
    expect(response.body.byStatus).toEqual({ APPROVED: 0, REJECTED: 0, PENDING_REVIEW: 0 });
    expect(response.body.flagged).toEqual({
      total: 0,
      pending: 0,
      approvedByManager: 0,
      rejectedByManager: 0,
    });
    // An empty LIST, not a zero total in an assumed currency. There is no
    // currency to name, so none is named.
    expect(response.body.amounts).toEqual([]);
  });

  // --- F06-T03 / T04: current status, not the original decision -----------
  it('F06-T03: an expense the policy flagged and a manager approved counts as APPROVED', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(nileCookie))
      .expect(200);

    const want = expected(COMPANY_A.id);

    // The fixture that makes this test meaningful: decision REVIEW, status
    // APPROVED. If the seed ever stops containing one, the assertion below
    // would pass vacuously - so its existence is asserted first.
    expect(want.flagged.approvedByManager).toBeGreaterThan(0);

    expect(response.body.flagged.approvedByManager).toBe(want.flagged.approvedByManager);
    // And it is NOT counted as pending, which is the mistake being prevented.
    expect(response.body.byStatus.PENDING_REVIEW).toBe(want.byStatus.PENDING_REVIEW);
    expect(response.body.flagged.pending).toBe(want.flagged.pending);
  });

  it('F06-T04: an expense the policy flagged and a manager rejected counts as REJECTED', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(deltaCookie))
      .expect(200);

    const want = expected(COMPANY_B.id);

    expect(want.flagged.rejectedByManager).toBeGreaterThan(0);
    expect(response.body.flagged.rejectedByManager).toBe(want.flagged.rejectedByManager);
    expect(response.body.byStatus.REJECTED).toBe(want.byStatus.REJECTED);
  });

  // --- F06-T05: another company's expenses are excluded -------------------
  it("F06-T05: another company's expenses are excluded from every figure", async () => {
    const nile = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(nileCookie))
      .expect(200);

    const delta = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(deltaCookie))
      .expect(200);

    expect(nile.body.total).toBe(expected(COMPANY_A.id).total);
    expect(delta.body.total).toBe(expected(COMPANY_B.id).total);

    // The decisive assertion: neither equals the whole table. Two companies
    // that happened to have the same count would make the two above pass
    // under a missing tenant predicate.
    const everything = await prisma.expense.count();
    expect(nile.body.total).toBeLessThan(everything);
    expect(delta.body.total).toBeLessThan(everything);
    expect(nile.body.total + delta.body.total).toBeLessThanOrEqual(everything);
  });

  // --- F06-T08 / T09 / T10: who may ask -----------------------------------
  it('F06-T08: an unauthenticated request is refused', async () => {
    await request(app.getHttpServer()).get('/v1/dashboard/summary').expect(401);
  });

  it('F06-T09: an API key cannot read the dashboard', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set('x-api-key', nileKey)
      .expect(403);

    // @Roles implies a human caller - the key is refused for its KIND, before
    // any question about roles arises.
    expect(response.body.error).toBe('caller_type_not_allowed');
  });

  it('F06-T10: the platform admin does not inherit manager access', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set(asManager(adminCookie))
      .expect(403);

    expect(response.body.error).toBe('insufficient_role');
  });

  it('F06-T10b: a session without the CSRF client header still reads', async () => {
    // GET is not state-changing, so CsrfGuard does not apply. Asserted rather
    // than assumed: if it DID apply, every dashboard load from a fresh tab
    // would fail and the cause would be invisible.
    await request(app.getHttpServer())
      .get('/v1/dashboard/summary')
      .set({ Cookie: nileCookie, origin: TEST_APP_ORIGIN })
      .expect(200);
  });
});
