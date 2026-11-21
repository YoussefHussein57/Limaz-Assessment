import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { asUser, createF08TestApp, login, TEST_APP_ORIGIN } from './f08-test-app';
import { resetDatabase } from '../test-db';

/**
 * F08-B01 to B15 - authorization and company management.
 */
describe('F08 admin companies', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  let adminCookie: string;
  let managerCookie: string;
  const created: string[] = [];

  beforeAll(async () => {
    const booted = await createF08TestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    adminCookie = await login(app, admin.email, admin.password);
    managerCookie = await login(app, nileManager.email, nileManager.password);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  const asAdmin = () => asUser(adminCookie);

  const createCompany = (body: object) =>
    request(app.getHttpServer()).post('/v1/admin/companies').set(asAdmin()).send(body);

  // --- F08-B01 to B04: who may list ---------------------------------------
  it('F08-B01: the platform admin lists companies', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/admin/companies')
      .set(asAdmin())
      .expect(200);

    const names = response.body.items.map((c: { name: string }) => c.name);

    // Across companies - which is the point. Every other endpoint in this
    // system would refuse to do this.
    expect(names).toContain(COMPANY_A.name);
    expect(names).toContain(COMPANY_B.name);
  });

  it('F08-B02: a company manager is refused', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/admin/companies')
      .set(asUser(managerCookie))
      .expect(403);

    expect(response.body.error).toBe('insufficient_role');
  });

  it('F08-B03: a company API key is refused', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/admin/companies')
      .set('x-api-key', nileKey)
      .expect(403);

    // @Roles implies a human caller - the key is refused for its KIND.
    expect(response.body.error).toBe('caller_type_not_allowed');
  });

  it('F08-B04: an unauthenticated caller is refused', async () => {
    await request(app.getHttpServer()).get('/v1/admin/companies').expect(401);
  });

  it('F08-B02b: a manager cannot create a company or touch keys', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/companies')
      .set(asUser(managerCookie))
      .send({ name: 'Should Not Exist', currency: 'SAR' })
      .expect(403);

    await request(app.getHttpServer())
      .get(`/v1/admin/companies/${COMPANY_A.id}/api-keys`)
      .set(asUser(managerCookie))
      .expect(403);

    expect(await prisma.company.findFirst({ where: { name: 'Should Not Exist' } })).toBeNull();
  });

  // --- F08-B05 to B10: creation -------------------------------------------
  it('F08-B05 / B09: creating a company initialises its policy and first key', async () => {
    const response = await createCompany({
      name: 'Red Sea Freight',
      currency: 'sar',
      autoApproveLimitMinor: 120_000,
      frequencyMaxCount: 4,
      frequencyWindowMinutes: 45,
      blockedCategories: ['  gambling ', 'GAMBLING', 'alcohol'],
    }).expect(201);

    created.push(response.body.company.id);

    expect(response.body.company.name).toBe('Red Sea Freight');
    // Uppercased, so `sar` and `SAR` cannot create two companies that differ
    // invisibly.
    expect(response.body.company.currency).toBe('SAR');

    // A5: the policy comes with it. A company without one accepts expense
    // submissions and cannot decide any of them.
    expect(response.body.company.policy).toEqual({
      autoApproveLimitMinor: 120_000,
      frequencyMaxCount: 4,
      frequencyWindowMinutes: 45,
      // Normalised and deduplicated by the SAME function the expense pipeline
      // uses - three entries in, two out.
      blockedCategories: ['ALCOHOL', 'GAMBLING'],
    });

    // A5 again: no manager. Said plainly rather than left to be discovered.
    expect(response.body.company.managerCount).toBe(0);

    expect(response.body.apiKey.plaintext).toMatch(/^lmz_test_[A-Za-z0-9_-]{43}$/u);
    expect(response.body.apiKey.key.state).toBe('ACTIVE');
  });

  it('F08-B05b: the defaults are applied when the policy is not supplied', async () => {
    const response = await createCompany({ name: 'Defaults Co', currency: 'SAR' }).expect(201);

    created.push(response.body.company.id);

    expect(response.body.company.policy).toEqual({
      autoApproveLimitMinor: 50_000,
      frequencyMaxCount: 3,
      frequencyWindowMinutes: 60,
      blockedCategories: [],
    });
  });

  it('F08-B06: an invalid payload is refused', async () => {
    await createCompany({ name: '', currency: 'SAR' }).expect(400);
    await createCompany({ name: 'X', currency: 'RIYAL' }).expect(400);
    await createCompany({ name: 'X', currency: 'SAR', autoApproveLimitMinor: -1 }).expect(400);
    await createCompany({ name: 'X', currency: 'SAR', frequencyMaxCount: 0 }).expect(400);
    await createCompany({ currency: 'SAR' }).expect(400);
  });

  it('F08-B08: an unknown property is refused, not silently dropped', async () => {
    const response = await createCompany({
      name: 'Typo Co',
      currency: 'SAR',
      // A plausible-looking field that does not exist. Dropping it quietly
      // would create a company initialised differently from what the
      // administrator believes they created.
      autoApproveLimit: 999,
    }).expect(400);

    expect(response.body.error).toBe('invalid_request');
    expect(await prisma.company.findFirst({ where: { name: 'Typo Co' } })).toBeNull();
  });

  it('F08-B10: nothing is left behind when creation fails', async () => {
    const before = await prisma.company.count();

    await createCompany({ name: 'Rolled Back Co', currency: 'NOPE' }).expect(400);

    expect(await prisma.company.count()).toBe(before);
    expect(await prisma.company.findFirst({ where: { name: 'Rolled Back Co' } })).toBeNull();
  });

  it('F08-B10b: a company is never created without its policy and key', async () => {
    // The invariant the transaction exists for, asserted across EVERY company
    // rather than only the ones this suite made.
    const companies = await prisma.company.findMany({
      include: { policy: true, _count: { select: { apiKeys: true } } },
    });

    expect(companies.length).toBeGreaterThan(0);

    for (const company of companies) {
      expect(company.policy).not.toBeNull();
      expect(company._count.apiKeys).toBeGreaterThan(0);
    }
  });

  // --- F08-B11 to B13: reading --------------------------------------------
  it('F08-B11: company details carry safe metadata only', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/admin/companies/${COMPANY_A.id}`)
      .set(asAdmin())
      .expect(200);

    expect(response.body.name).toBe(COMPANY_A.name);
    expect(response.body.policy).not.toBeNull();

    // Nothing about expenses: an administrator managing accounts is not the
    // same as an administrator reading a company's spending.
    expect(response.body).not.toHaveProperty('expenses');
    expect(JSON.stringify(response.body)).not.toMatch(/keyHash|passwordHash|tokenHash/u);
  });

  it('F08-B12: an unknown company answers 404', async () => {
    await request(app.getHttpServer())
      .get('/v1/admin/companies/00000000-0000-7000-8000-000000000000')
      .set(asAdmin())
      .expect(404);

    // A malformed id is 400, not 404: the id is unusable, which is a
    // different fact from "there is no such company".
    await request(app.getHttpServer())
      .get('/v1/admin/companies/not-a-uuid')
      .set(asAdmin())
      .expect(400);
  });

  it('F08-B13: listing is bounded and pages deterministically', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page += 1) {
      const url: string = `/v1/admin/companies?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await request(app.getHttpServer()).get(url).set(asAdmin()).expect(200);

      seen.push(...response.body.items.map((c: { id: string }) => c.id));
      cursor = response.body.nextCursor;

      if (!cursor) {
        break;
      }
    }

    const total = await prisma.company.count();

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    await request(app.getHttpServer())
      .get('/v1/admin/companies?limit=101')
      .set(asAdmin())
      .expect(400);
  });

  it('F08-B13b: search matches the company name', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/admin/companies?q=nile')
      .set(asAdmin())
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].name).toBe(COMPANY_A.name);
  });

  // --- F08-B14: CSRF -------------------------------------------------------
  it('F08-B14: a mutation without the CSRF header is refused', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/companies')
      .set({ Cookie: adminCookie, origin: TEST_APP_ORIGIN })
      .send({ name: 'No CSRF Co', currency: 'SAR' })
      .expect(403);

    await request(app.getHttpServer())
      .post('/v1/admin/companies')
      .set({ Cookie: adminCookie, origin: 'http://evil.invalid', 'x-limaz-client': '1' })
      .send({ name: 'Foreign Origin Co', currency: 'SAR' })
      .expect(403);

    expect(await prisma.company.findFirst({ where: { name: 'No CSRF Co' } })).toBeNull();
    expect(await prisma.company.findFirst({ where: { name: 'Foreign Origin Co' } })).toBeNull();
  });

  // --- F08-B15: the created company actually works ------------------------
  it('F08-B15: a newly created company accepts a real expense with its new key', async () => {
    const response = await createCompany({
      name: 'End To End Co',
      currency: 'SAR',
      autoApproveLimitMinor: 10_000,
    }).expect(201);

    created.push(response.body.company.id);

    const key = response.body.apiKey.plaintext as string;

    // THE TEST THAT MATTERS. Not "the response contained a key" but "the key
    // authenticates, the company is initialised, and the policy decides".
    const submitted = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', key)
      .send({
        externalId: 'first-expense',
        employeeId: 'emp-1',
        amount: 25_000,
        currency: 'SAR',
        merchant: 'First Supplier',
        category: 'OFFICE',
        spentAt: new Date().toISOString(),
      })
      .expect(201);

    // Over the 10,000 limit this company was created with - so the policy
    // created in that same transaction is the one being applied.
    expect(submitted.body.decision).toBe('REVIEW');
    expect(submitted.body.reasons[0].detail).toMatchObject({ autoApproveLimitMinor: 10_000 });

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: submitted.body.id } });
    expect(expense.companyId).toBe(response.body.company.id);
  });
});
