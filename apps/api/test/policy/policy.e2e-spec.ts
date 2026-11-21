import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { asManager, createF07TestApp, login, TEST_APP_ORIGIN } from './f07-test-app';
import { resetDatabase } from '../test-db';

/**
 * F07-B01 to B20 - company policy settings.
 *
 * The policy is restored to its fixture values after every test that changes
 * it, so these can run in any order and a failure in one cannot cascade.
 */
describe('F07 company policy', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const deltaManager = USERS.find((u) => u.companyId === COMPANY_B.id)!;
  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  let nileCookie: string;
  let deltaCookie: string;
  let adminCookie: string;

  const restoreNilePolicy = async () => {
    await prisma.policy.update({
      where: { companyId: COMPANY_A.id },
      data: {
        autoApproveLimitMinor: COMPANY_A.policy.autoApproveLimitMinor,
        frequencyMaxCount: COMPANY_A.policy.frequencyMaxCount,
        frequencyWindowMinutes: COMPANY_A.policy.frequencyWindowMinutes,
        blockedCategories: [...COMPANY_A.policy.blockedCategories],
      },
    });
  };

  beforeAll(async () => {
    const booted = await createF07TestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    nileCookie = await login(app, nileManager.email, nileManager.password);
    deltaCookie = await login(app, deltaManager.email, deltaManager.password);
    adminCookie = await login(app, admin.email, admin.password);
  }, 90_000);

  afterEach(restoreNilePolicy);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  const patch = (cookie: string, body: object) =>
    request(app.getHttpServer()).patch('/v1/policy').set(asManager(cookie)).send(body);

  // --- F07-B01: read -------------------------------------------------------
  it('F07-B01: a manager reads their own company policy', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/policy')
      .set(asManager(nileCookie))
      .expect(200);

    expect(response.body).toEqual({
      autoApproveLimitMinor: COMPANY_A.policy.autoApproveLimitMinor,
      frequencyMaxCount: COMPANY_A.policy.frequencyMaxCount,
      frequencyWindowMinutes: COMPANY_A.policy.frequencyWindowMinutes,
      blockedCategories: [...COMPANY_A.policy.blockedCategories].sort(),
      currency: COMPANY_A.currency,
      updatedAt: expect.any(String),
    });
  });

  it('F07-B19: the response carries no internal identifiers', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/policy')
      .set(asManager(nileCookie))
      .expect(200);

    expect(response.body).not.toHaveProperty('id');
    expect(response.body).not.toHaveProperty('companyId');
  });

  it('F07-B09: the two companies read different policies', async () => {
    const nile = await request(app.getHttpServer())
      .get('/v1/policy')
      .set(asManager(nileCookie))
      .expect(200);

    const delta = await request(app.getHttpServer())
      .get('/v1/policy')
      .set(asManager(deltaCookie))
      .expect(200);

    // The fixtures differ on every numeric field, which is what makes the
    // isolation test below meaningful rather than a coincidence.
    expect(nile.body.autoApproveLimitMinor).not.toBe(delta.body.autoApproveLimitMinor);
    expect(nile.body.frequencyMaxCount).not.toBe(delta.body.frequencyMaxCount);
    expect(nile.body.frequencyWindowMinutes).not.toBe(delta.body.frequencyWindowMinutes);
  });

  // --- F07-B02: update -----------------------------------------------------
  it('F07-B02: a manager updates the permitted fields', async () => {
    const response = await patch(nileCookie, {
      autoApproveLimitMinor: 75_000,
      frequencyMaxCount: 5,
      frequencyWindowMinutes: 30,
      blockedCategories: ['GAMBLING', 'ALCOHOL'],
    }).expect(200);

    expect(response.body.autoApproveLimitMinor).toBe(75_000);
    expect(response.body.frequencyMaxCount).toBe(5);
    expect(response.body.frequencyWindowMinutes).toBe(30);
    expect(response.body.blockedCategories).toEqual(['ALCOHOL', 'GAMBLING']);

    const row = await prisma.policy.findUniqueOrThrow({ where: { companyId: COMPANY_A.id } });
    expect(row.autoApproveLimitMinor).toBe(75_000);
  });

  it('F07-B02b: an absent field is left alone, not cleared', async () => {
    // The reason this is a PATCH. Under PUT semantics this request would wipe
    // the blocked list, and the company would stop blocking anything without
    // a single error being raised.
    await patch(nileCookie, { autoApproveLimitMinor: 12_345 }).expect(200);

    const row = await prisma.policy.findUniqueOrThrow({ where: { companyId: COMPANY_A.id } });

    expect(row.autoApproveLimitMinor).toBe(12_345);
    expect(row.blockedCategories).toEqual(COMPANY_A.policy.blockedCategories);
    expect(row.frequencyMaxCount).toBe(COMPANY_A.policy.frequencyMaxCount);
  });

  it('F07-B02c: an empty request body is refused', async () => {
    const response = await patch(nileCookie, {}).expect(400);

    // 200 would claim something was saved when nothing was.
    expect(response.body.error).toBe('invalid_request');
  });

  // --- F07-B03 to B05: validation -----------------------------------------
  it('F07-B03: an invalid monetary limit is refused', async () => {
    await patch(nileCookie, { autoApproveLimitMinor: -1 }).expect(400);
    await patch(nileCookie, { autoApproveLimitMinor: 12.5 }).expect(400);
    await patch(nileCookie, { autoApproveLimitMinor: '50000' }).expect(400);
    await patch(nileCookie, { autoApproveLimitMinor: 2_147_483_648 }).expect(400);

    // Zero IS valid: "every expense needs a human" is a coherent policy.
    await patch(nileCookie, { autoApproveLimitMinor: 0 }).expect(200);
  });

  it('F07-B04: an invalid frequency configuration is refused', async () => {
    await patch(nileCookie, { frequencyMaxCount: 0 }).expect(400);
    await patch(nileCookie, { frequencyMaxCount: -3 }).expect(400);
    await patch(nileCookie, { frequencyMaxCount: 2.5 }).expect(400);
    await patch(nileCookie, { frequencyWindowMinutes: 0 }).expect(400);
    await patch(nileCookie, { frequencyWindowMinutes: 1_441 }).expect(400);
  });

  it('F07-B05: an invalid blocked category is refused', async () => {
    await patch(nileCookie, { blockedCategories: 'GAMBLING' }).expect(400);
    await patch(nileCookie, { blockedCategories: [123] }).expect(400);
    await patch(nileCookie, { blockedCategories: [''] }).expect(400);
    await patch(nileCookie, { blockedCategories: ['x'.repeat(65)] }).expect(400);
    await patch(nileCookie, {
      blockedCategories: Array.from({ length: 101 }, (_, i) => `CATEGORY-${i}`),
    }).expect(400);

    // An empty list is valid and means "nothing is blocked".
    const cleared = await patch(nileCookie, { blockedCategories: [] }).expect(200);
    expect(cleared.body.blockedCategories).toEqual([]);
  });

  it('F07-B06: duplicates collapse after normalisation, not before', async () => {
    const response = await patch(nileCookie, {
      blockedCategories: ['gambling', 'GAMBLING', ' Gambling ', 'alcohol'],
    }).expect(200);

    // Four entries in, two out. Deduplicating the RAW strings would have
    // stored four rows that all mean the same thing and rendered a confusing
    // list back to the manager.
    expect(response.body.blockedCategories).toEqual(['ALCOHOL', 'GAMBLING']);
  });

  it('F07-B07: the stored form matches what the expense pipeline produces', async () => {
    await patch(nileCookie, { blockedCategories: ['  casino   games '] }).expect(200);

    const row = await prisma.policy.findUniqueOrThrow({ where: { companyId: COMPANY_A.id } });

    // normaliseCategory: NFC, trim, collapse inner whitespace, uppercase.
    // THE SAME function the submission pipeline runs on an expense's
    // category - which is why it was extracted in F03. Two implementations
    // would let a manager type " gambling " here, an expense arrive as
    // "GAMBLING", and the rule silently stop firing.
    expect(row.blockedCategories).toEqual(['CASINO GAMES']);
  });

  it('F07-B07b: a category stored this way actually blocks a matching expense', async () => {
    // The end-to-end version of B07: not "the strings look the same" but
    // "the rule fires".
    await patch(nileCookie, { blockedCategories: ['  casino   games '] }).expect(200);

    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send({
        externalId: `policy-block-${Date.now()}`,
        employeeId: 'emp-policy-block',
        amount: 100,
        currency: 'SAR',
        merchant: 'Somewhere',
        category: 'Casino Games',
        spentAt: new Date().toISOString(),
      })
      .expect(201);

    expect(response.body.decision).toBe('REJECT');
    expect(response.body.reasons.map((r: { code: string }) => r.code)).toContain(
      'BLOCKED_CATEGORY',
    );

    await prisma.ruleHit.deleteMany({ where: { expenseId: response.body.id } });
    await prisma.expense.delete({ where: { id: response.body.id } });
  });

  // --- F07-B08 to B13: authorization --------------------------------------
  it('F07-B08: a body naming another company is refused, not ignored', async () => {
    const response = await patch(nileCookie, {
      companyId: COMPANY_B.id,
      autoApproveLimitMinor: 1,
    }).expect(400);

    expect(response.body.error).toBe('invalid_request');

    // And Delta is untouched.
    const delta = await prisma.policy.findUniqueOrThrow({ where: { companyId: COMPANY_B.id } });
    expect(delta.autoApproveLimitMinor).toBe(COMPANY_B.policy.autoApproveLimitMinor);
  });

  it("F07-B09b: updating one company's policy leaves the other unchanged", async () => {
    await patch(nileCookie, { autoApproveLimitMinor: 99_999 }).expect(200);

    const delta = await prisma.policy.findUniqueOrThrow({ where: { companyId: COMPANY_B.id } });

    expect(delta.autoApproveLimitMinor).toBe(COMPANY_B.policy.autoApproveLimitMinor);
    expect(delta.frequencyMaxCount).toBe(COMPANY_B.policy.frequencyMaxCount);
  });

  it('F07-B10: an unauthenticated caller is refused on both routes', async () => {
    await request(app.getHttpServer()).get('/v1/policy').expect(401);
    await request(app.getHttpServer())
      .patch('/v1/policy')
      .set({ origin: TEST_APP_ORIGIN, 'x-limaz-client': '1' })
      .send({ autoApproveLimitMinor: 1 })
      .expect(401);
  });

  it('F07-B11: a company API key cannot read or change the policy', async () => {
    const read = await request(app.getHttpServer())
      .get('/v1/policy')
      .set('x-api-key', nileKey)
      .expect(403);

    expect(read.body.error).toBe('caller_type_not_allowed');

    await request(app.getHttpServer())
      .patch('/v1/policy')
      .set('x-api-key', nileKey)
      .send({ autoApproveLimitMinor: 1 })
      .expect(403);
  });

  it('F07-B12: the platform admin does not inherit policy access', async () => {
    const read = await request(app.getHttpServer())
      .get('/v1/policy')
      .set(asManager(adminCookie))
      .expect(403);

    expect(read.body.error).toBe('insufficient_role');

    await patch(adminCookie, { autoApproveLimitMinor: 1 }).expect(403);
  });

  it('F07-B13: a state-changing request without the CSRF header is refused', async () => {
    const response = await request(app.getHttpServer())
      .patch('/v1/policy')
      .set({ Cookie: nileCookie, origin: TEST_APP_ORIGIN })
      .send({ autoApproveLimitMinor: 1 })
      .expect(403);

    expect(response.body.error).toBeTruthy();

    // A foreign Origin is refused too, with the header present.
    await request(app.getHttpServer())
      .patch('/v1/policy')
      .set({ Cookie: nileCookie, origin: 'http://evil.invalid', 'x-limaz-client': '1' })
      .send({ autoApproveLimitMinor: 1 })
      .expect(403);
  });

  // --- F07-B14 to B17: history is not rewritten ---------------------------
  it('F07-B14: a NEW expense is evaluated against the updated policy', async () => {
    // Under the seeded limit of 50,000 this would be APPROVE.
    await patch(nileCookie, { autoApproveLimitMinor: 10_000 }).expect(200);

    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send({
        externalId: `policy-new-${Date.now()}`,
        employeeId: 'emp-policy-new',
        amount: 20_000,
        currency: 'SAR',
        merchant: 'After The Change',
        category: 'OFFICE',
        spentAt: new Date().toISOString(),
      })
      .expect(201);

    expect(response.body.decision).toBe('REVIEW');
    expect(response.body.reasons[0].detail).toMatchObject({ autoApproveLimitMinor: 10_000 });

    await prisma.review.deleteMany({ where: { expenseId: response.body.id } });
    await prisma.ruleHit.deleteMany({ where: { expenseId: response.body.id } });
    await prisma.expense.delete({ where: { id: response.body.id } });
  });

  it('F07-B15: an identical retry of an older expense keeps its original decision', async () => {
    const payload = {
      externalId: `policy-retry-${Date.now()}`,
      employeeId: 'emp-policy-retry',
      amount: 20_000,
      currency: 'SAR',
      merchant: 'Before The Change',
      category: 'OFFICE',
      spentAt: new Date().toISOString(),
    };

    const first = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send(payload)
      .expect(201);

    expect(first.body.decision).toBe('APPROVE');

    // Tighten the policy so the same payload WOULD now be flagged.
    await patch(nileCookie, { autoApproveLimitMinor: 10_000 }).expect(200);

    const retry = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send(payload)
      .expect(200);

    // The retry returns the ORIGINAL decision. Idempotency is about the
    // expense, not about re-running the rules: the same submission must not
    // mean two different things depending on when it was retried.
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.decision).toBe('APPROVE');
    expect(retry.body.id).toBe(first.body.id);

    await prisma.ruleHit.deleteMany({ where: { expenseId: first.body.id } });
    await prisma.expense.delete({ where: { id: first.body.id } });
  });

  it('F07-B16: an already-evaluated expense keeps its snapshot and reasons', async () => {
    const row = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id, externalId: 'exp-1005' },
      include: { ruleHits: true },
    });

    await patch(nileCookie, {
      autoApproveLimitMinor: 1,
      frequencyMaxCount: 1,
      frequencyWindowMinutes: 1,
      blockedCategories: ['EVERYTHING'],
    }).expect(200);

    const after = await prisma.expense.findFirstOrThrow({
      where: { id: row.id },
      include: { ruleHits: true },
    });

    expect(after.policySnapshot).toEqual(row.policySnapshot);
    expect(after.decision).toBe(row.decision);
    expect(after.status).toBe(row.status);
    expect(after.ruleHits).toHaveLength(row.ruleHits.length);
  });

  it('F07-B17: a resolved review is not reopened by a policy change', async () => {
    const before = await prisma.review.findFirstOrThrow({
      where: { companyId: COMPANY_A.id, state: 'RESOLVED' },
    });

    await patch(nileCookie, { autoApproveLimitMinor: 1 }).expect(200);

    const after = await prisma.review.findFirstOrThrow({ where: { id: before.id } });

    expect(after.state).toBe('RESOLVED');
    expect(after.outcome).toBe(before.outcome);
    expect(after.resolvedByUserId).toBe(before.resolvedByUserId);
    expect(after.resolvedAt?.toISOString()).toBe(before.resolvedAt?.toISOString());
  });

  it('F07-B18: a rejected update leaves the policy exactly as it was', async () => {
    const before = await prisma.policy.findUniqueOrThrow({ where: { companyId: COMPANY_A.id } });

    // One valid field and one invalid one. Zod validates the whole object, so
    // nothing is applied - a partial write here would leave a policy the
    // manager never asked for.
    await patch(nileCookie, {
      autoApproveLimitMinor: 123_456,
      frequencyMaxCount: -1,
    }).expect(400);

    const after = await prisma.policy.findUniqueOrThrow({ where: { companyId: COMPANY_A.id } });

    expect(after.autoApproveLimitMinor).toBe(before.autoApproveLimitMinor);
    expect(after.frequencyMaxCount).toBe(before.frequencyMaxCount);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });
});
