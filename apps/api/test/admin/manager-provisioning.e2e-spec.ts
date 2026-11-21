import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { asUser, login, TEST_APP_ORIGIN } from './f08-test-app';
import { createF11TestApp } from './f11-test-app';
import { resetDatabase } from '../test-db';

/**
 * F11 - company manager provisioning.
 *
 * The claim this suite exists to support is narrow and checkable: an
 * administrator can take a company from "created" to "somebody can sign in
 * and resolve its reviews" entirely through the API, with no direct database
 * insertion anywhere. R-32 is closed only if that holds end to end, so the
 * last cases here do not stop at a 201 - they log the new account in, submit
 * an expense that needs a review, and resolve it.
 */
describe('F11 manager provisioning', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  let adminCookie: string;
  let managerCookie: string;

  /** A fresh company per run of the whole suite, so counts are predictable. */
  let targetCompanyId: string;
  let targetKey: string;

  /** Unique per run so a re-run does not trip the global email constraint. */
  const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const VALID_PASSWORD = 'ProvisionedManager!2026';

  beforeAll(async () => {
    const booted = await createF11TestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    adminCookie = await login(app, admin.email, admin.password);
    managerCookie = await login(app, nileManager.email, nileManager.password);

    const created = await request(app.getHttpServer())
      .post('/v1/admin/companies')
      .set(asUser(adminCookie))
      .send({ name: 'F11 Target Co', currency: 'SAR', autoApproveLimitMinor: 20_000 })
      .expect(201);

    targetCompanyId = created.body.company.id;
    targetKey = created.body.apiKey.plaintext;
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  const asAdmin = () => asUser(adminCookie);

  const managersUrl = (companyId = targetCompanyId) =>
    `/v1/admin/companies/${companyId}/managers`;

  const createManager = (body: object, companyId = targetCompanyId) =>
    request(app.getHttpServer()).post(managersUrl(companyId)).set(asAdmin()).send(body);

  // --- F11-T01/T02: the happy path ----------------------------------------

  it('F11-T01: a brand new company starts with no managers', async () => {
    const response = await request(app.getHttpServer())
      .get(managersUrl())
      .set(asAdmin())
      .expect(200);

    expect(response.body.items).toEqual([]);
  });

  it('F11-T02: the administrator creates a manager', async () => {
    const email = `first-${stamp()}@f11.test`;

    const response = await createManager({
      displayName: 'First Manager',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    expect(response.body).toMatchObject({
      displayName: 'First Manager',
      email,
      role: 'MANAGER',
    });
    expect(typeof response.body.id).toBe('string');
    expect(typeof response.body.createdAt).toBe('string');
  });

  it('F11-T03: the new account appears in the listing', async () => {
    const response = await request(app.getHttpServer())
      .get(managersUrl())
      .set(asAdmin())
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].role).toBe('MANAGER');
  });

  // --- F11-T04 to T09: validation -----------------------------------------

  it('F11-T04: an unknown company is 404, not a foreign-key 500', async () => {
    // A well-formed UUID that is not a company. The point is that the failure
    // is recognised BEFORE the insert, so it reads as "no such company".
    const response = await createManager(
      { displayName: 'Nobody', email: `ghost-${stamp()}@f11.test`, password: VALID_PASSWORD },
      '01930000-0000-7000-8000-000000000999',
    ).expect(404);

    expect(response.body.error).toBe('not_found');
  });

  it('F11-T04b: a malformed company id is 400', async () => {
    await createManager(
      { displayName: 'Nobody', email: `bad-${stamp()}@f11.test`, password: VALID_PASSWORD },
      'not-a-uuid',
    ).expect(400);
  });

  it('F11-T05: an empty display name is refused', async () => {
    const response = await createManager({
      displayName: '   ',
      email: `blank-${stamp()}@f11.test`,
      password: VALID_PASSWORD,
    }).expect(400);

    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toContain('displayName');
  });

  it('F11-T06: a malformed email is refused', async () => {
    const response = await createManager({
      displayName: 'Bad Email',
      email: 'not-an-email',
      password: VALID_PASSWORD,
    }).expect(400);

    expect(response.body.message).toContain('email');
  });

  it('F11-T06b: a duplicate email is a 409, from the database', async () => {
    const email = `dupe-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Original',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const response = await createManager({
      displayName: 'Impostor',
      email,
      password: VALID_PASSWORD,
    }).expect(409);

    expect(response.body.error).toBe('conflict');
    expect(response.body.details.conflictingField).toBe('email');
  });

  it('F11-T06c: the email is unique GLOBALLY, not per company', async () => {
    const email = `cross-${stamp()}@f11.test`;

    await createManager({
      displayName: 'In target company',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    // The same address in a DIFFERENT company. Login takes an email and a
    // password with no company selector, so an address that identified two
    // users would make login ambiguous. The constraint is what prevents it.
    await createManager(
      { displayName: 'In Delta', email, password: VALID_PASSWORD },
      COMPANY_B.id,
    ).expect(409);
  });

  it('F11-T06d: two simultaneous creations of the same email produce exactly one account', async () => {
    const email = `race-${stamp()}@f11.test`;

    const [a, b] = await Promise.all([
      createManager({ displayName: 'Racer A', email, password: VALID_PASSWORD }),
      createManager({ displayName: 'Racer B', email, password: VALID_PASSWORD }),
    ]);

    const codes = [a.status, b.status].sort((x, y) => x - y);

    // One wins, the other is told clearly. Neither is a 500: the loser's
    // unique violation is translated, not leaked.
    expect(codes).toEqual([201, 409]);

    const rows = await prisma.user.count({ where: { email } });
    expect(rows).toBe(1);
  });

  it('F11-T07: the email is normalised the same way login normalises it', async () => {
    const local = `MiXeD-${stamp()}`;
    const typed = `  ${local}@F11.TEST  `;

    const created = await createManager({
      displayName: 'Mixed Case',
      email: typed,
      password: VALID_PASSWORD,
    }).expect(201);

    expect(created.body.email).toBe(`${local.toLowerCase()}@f11.test`);

    // And it can actually sign in with the address as typed, which is the
    // only reason the normalisation matters.
    await login(app, typed, VALID_PASSWORD);
  });

  it('F11-T08: a short password is refused', async () => {
    const response = await createManager({
      displayName: 'Short',
      email: `short-${stamp()}@f11.test`,
      password: 'short',
    }).expect(400);

    expect(response.body.message).toContain('password');
  });

  it('F11-T08b: a password beyond bcrypt’s 72 bytes is refused, not truncated', async () => {
    // bcrypt hashes at most 72 bytes and silently discards the rest. Accepting
    // this would create an account with far less entropy than the person
    // believes they set, and nothing would say so.
    const response = await createManager({
      displayName: 'Too long',
      email: `long-${stamp()}@f11.test`,
      password: 'a'.repeat(73),
    }).expect(400);

    expect(response.body.message).toContain('72 bytes');
  });

  it('F11-T09: an unknown property is refused rather than ignored', async () => {
    await createManager({
      displayName: 'Typo',
      email: `typo-${stamp()}@f11.test`,
      password: VALID_PASSWORD,
      diplayName: 'typo in a field name',
    }).expect(400);
  });

  // --- F11-T10/T11: the two fields the caller cannot set -------------------

  it('F11-T10: a body claiming PLATFORM_ADMIN is refused, and creates nothing', async () => {
    const email = `escalate-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Would-be admin',
      email,
      password: VALID_PASSWORD,
      role: 'PLATFORM_ADMIN',
    }).expect(400);

    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('F11-T11: a body claiming another companyId is refused, and creates nothing', async () => {
    const email = `tenant-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Would-be elsewhere',
      email,
      password: VALID_PASSWORD,
      companyId: COMPANY_B.id,
    }).expect(400);

    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('F11-T11b: the company comes from the PATH, whatever the body said', async () => {
    const email = `path-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Path wins',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });

    expect(row.companyId).toBe(targetCompanyId);
    expect(row.role).toBe('MANAGER');
  });

  // --- F11-T12/T13: the password at rest and in the response ---------------

  it('F11-T12: the password is stored as a bcrypt hash, never in plaintext', async () => {
    const email = `hash-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Hashed',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });

    expect(row.passwordHash).not.toBe(VALID_PASSWORD);
    expect(row.passwordHash).not.toContain(VALID_PASSWORD);
    // A bcrypt digest, same shape the seeded accounts carry.
    expect(row.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/u);
  });

  it('F11-T13: no response ever carries a password or a hash', async () => {
    const email = `quiet-${stamp()}@f11.test`;

    const created = await createManager({
      displayName: 'Quiet',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const listed = await request(app.getHttpServer())
      .get(managersUrl())
      .set(asAdmin())
      .expect(200);

    for (const body of [created.body, listed.body]) {
      const serialised = JSON.stringify(body);

      expect(serialised).not.toContain(VALID_PASSWORD);
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('$2a$');
      expect(serialised).not.toContain('$2b$');
    }
  });

  // --- F11-T14/T15: the account actually works -----------------------------

  it('F11-T14: the new account authenticates and lands in the right company', async () => {
    const email = `signin-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Signs In',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const cookie = await login(app, email, VALID_PASSWORD);

    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set(asUser(cookie))
      .expect(200);

    expect(me.body.user.role).toBe('MANAGER');
    expect(me.body.company.id).toBe(targetCompanyId);
  });

  it('F11-T14b: the wrong password still fails for a provisioned account', async () => {
    const email = `wrongpw-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Wrong password',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('origin', TEST_APP_ORIGIN)
      .set('x-limaz-client', '1')
      .send({ email, password: `${VALID_PASSWORD}x` })
      .expect(401);
  });

  it('F11-T15: a company can have several managers', async () => {
    const before = await request(app.getHttpServer())
      .get(managersUrl())
      .set(asAdmin())
      .expect(200);

    const a = `multi-a-${stamp()}@f11.test`;
    const b = `multi-b-${stamp()}@f11.test`;

    await createManager({ displayName: 'Multi A', email: a, password: VALID_PASSWORD }).expect(201);
    await createManager({ displayName: 'Multi B', email: b, password: VALID_PASSWORD }).expect(201);

    const after = await request(app.getHttpServer())
      .get(managersUrl())
      .set(asAdmin())
      .expect(200);

    expect(after.body.items).toHaveLength(before.body.items.length + 2);

    const emails = after.body.items.map((m: { email: string }) => m.email);
    expect(emails).toContain(a);
    expect(emails).toContain(b);

    // Both in the SAME company, and both only that company.
    const rows = await prisma.user.findMany({ where: { email: { in: [a, b] } } });
    expect(rows.every((r) => r.companyId === targetCompanyId)).toBe(true);
  });

  it('F11-T16: a provisioned manager cannot reach another company’s data', async () => {
    const email = `isolated-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Isolated',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const cookie = await login(app, email, VALID_PASSWORD);

    // Company A has seeded expenses. A real id, from a real company, held by
    // a manager of a different one - the exact case the assessment names.
    const foreign = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id },
    });

    // 404, not 403: at the ROW layer a 403 would confirm the id exists
    // (ADR-003).
    await request(app.getHttpServer())
      .get(`/v1/expenses/${foreign.id}`)
      .set(asUser(cookie))
      .expect(404);

    const own = await request(app.getHttpServer())
      .get('/v1/expenses')
      .set(asUser(cookie))
      .expect(200);

    expect(own.body.items).toEqual([]);
  });

  it('F11-T16b: a provisioned manager cannot reach platform administration', async () => {
    const email = `notadmin-${stamp()}@f11.test`;

    await createManager({
      displayName: 'Not an admin',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const cookie = await login(app, email, VALID_PASSWORD);

    const response = await request(app.getHttpServer())
      .get('/v1/admin/companies')
      .set(asUser(cookie))
      .expect(403);

    expect(response.body.error).toBe('insufficient_role');

    // And specifically cannot provision further managers - the escalation
    // that would make F11 a privilege ladder.
    await request(app.getHttpServer())
      .post(managersUrl())
      .set(asUser(cookie))
      .send({ displayName: 'Chain', email: `chain-${stamp()}@f11.test`, password: VALID_PASSWORD })
      .expect(403);
  });

  // --- F11-T17 to T20: who may call these routes at all --------------------

  it('F11-T17: a seeded company manager is refused both routes', async () => {
    const list = await request(app.getHttpServer())
      .get(managersUrl())
      .set(asUser(managerCookie))
      .expect(403);

    expect(list.body.error).toBe('insufficient_role');

    await request(app.getHttpServer())
      .post(managersUrl())
      .set(asUser(managerCookie))
      .send({ displayName: 'No', email: `no-${stamp()}@f11.test`, password: VALID_PASSWORD })
      .expect(403);
  });

  it('F11-T18: a company API key is refused for its KIND', async () => {
    const list = await request(app.getHttpServer())
      .get(managersUrl())
      .set('x-api-key', nileKey)
      .expect(403);

    // @Roles implies a human caller: a key has no role, so it can never
    // satisfy one however valid it is.
    expect(list.body.error).toBe('caller_type_not_allowed');

    await request(app.getHttpServer())
      .post(managersUrl())
      .set('x-api-key', targetKey)
      .send({ displayName: 'No', email: `nokey-${stamp()}@f11.test`, password: VALID_PASSWORD })
      .expect(403);
  });

  it('F11-T19: an unauthenticated caller is refused', async () => {
    await request(app.getHttpServer()).get(managersUrl()).expect(401);

    await request(app.getHttpServer())
      .post(managersUrl())
      .set('origin', TEST_APP_ORIGIN)
      .set('x-limaz-client', '1')
      .send({ displayName: 'No', email: `anon-${stamp()}@f11.test`, password: VALID_PASSWORD })
      .expect(401);
  });

  it('F11-T20: CSRF protection still applies to manager creation', async () => {
    const email = `csrf-${stamp()}@f11.test`;

    // No x-limaz-client header: a cross-origin <form> cannot set one.
    const missingHeader = await request(app.getHttpServer())
      .post(managersUrl())
      .set('Cookie', adminCookie)
      .set('origin', TEST_APP_ORIGIN)
      .send({ displayName: 'CSRF', email, password: VALID_PASSWORD })
      .expect(403);

    expect(missingHeader.body.error).toBe('csrf_header_required');

    // A hostile origin, with the header present.
    const badOrigin = await request(app.getHttpServer())
      .post(managersUrl())
      .set('Cookie', adminCookie)
      .set('origin', 'https://evil.example')
      .set('x-limaz-client', '1')
      .send({ displayName: 'CSRF', email, password: VALID_PASSWORD })
      .expect(403);

    expect(badOrigin.body.error).toBe('cross_origin_rejected');

    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  // --- F11-T21/T22: the point of the whole feature -------------------------

  it('F11-T21: the company detail reflects the new managers', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/companies/${targetCompanyId}`)
      .set(asAdmin())
      .expect(200);

    const listed = await request(app.getHttpServer())
      .get(managersUrl())
      .set(asAdmin())
      .expect(200);

    expect(detail.body.managerCount).toBe(listed.body.items.length);
    expect(detail.body.managerCount).toBeGreaterThan(0);
  });

  it('F11-T22: a provisioned manager resolves a review and is recorded as the reviewer', async () => {
    const email = `reviewer-${stamp()}@f11.test`;

    const created = await createManager({
      displayName: 'The Reviewer',
      email,
      password: VALID_PASSWORD,
    }).expect(201);

    const reviewerId: string = created.body.id;
    const cookie = await login(app, email, VALID_PASSWORD);

    // An expense over this company's 200.00 limit, submitted with the
    // company's OWN key - the whole path, no direct insertion anywhere.
    const externalId = `f11-review-${stamp()}`;

    const submitted = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', targetKey)
      .send({
        externalId,
        employeeId: 'emp-f11',
        amount: 90_000,
        currency: 'SAR',
        merchant: 'Expensive Supplier',
        category: 'OFFICE',
        spentAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(201);

    expect(submitted.body.decision).toBe('REVIEW');

    const review = await prisma.review.findFirstOrThrow({
      where: { companyId: targetCompanyId, expense: { externalId } },
    });

    await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set(asUser(cookie))
      .send({ decision: 'APPROVE' })
      .expect(200);

    const resolved = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });

    expect(resolved.state).toBe('RESOLVED');
    expect(resolved.outcome).toBe('APPROVED');
    // The reviewer is the logged-in manager - the account that did not exist
    // when this suite started. This is what closing R-32 actually means.
    expect(resolved.resolvedByUserId).toBe(reviewerId);
    expect(resolved.resolvedAt).not.toBeNull();

    const expense = await prisma.expense.findFirstOrThrow({ where: { externalId } });
    expect(expense.status).toBe('APPROVED');
    // The automated decision is history and does not change.
    expect(expense.decision).toBe('REVIEW');
  });
});
