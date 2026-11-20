import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { TEST_APP_ORIGIN, createAuthTestApp } from './auth-test-app';

const CSRF = 'x-limaz-client';
const COOKIE = 'limaz_session';

const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
const deltaManager = USERS.find((u) => u.companyId === COMPANY_B.id)!;
const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

function tokenFrom(setCookie: string[] | string | undefined): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = headers.find((h) => h.startsWith(`${COOKIE}=`));
  if (!header) {
    throw new Error('no session cookie was set');
  }
  return header.slice(`${COOKIE}=`.length).split(';')[0]!;
}

/**
 * F02-T12 to F02-T16, plus the CSRF and Origin layers.
 *
 * This is the file that matters most. Everything else in F02 exists so that
 * these assertions can be made.
 */
describe('F02 authorization and tenant isolation', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  let nileCookie: string;
  let deltaCookie: string;
  let adminCookie: string;
  let nileExpenseId: string;
  let deltaExpenseId: string;

  beforeAll(async () => {
    const booted = await createAuthTestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    const signIn = async (email: string, password: string): Promise<string> => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set(CSRF, '1')
        .send({ email, password })
        .expect(200);
      return tokenFrom(response.headers['set-cookie']);
    };

    nileCookie = await signIn(nileManager.email, nileManager.password);
    deltaCookie = await signIn(deltaManager.email, deltaManager.password);
    adminCookie = await signIn(admin.email, admin.password);

    nileExpenseId = (
      await prisma.expense.findFirstOrThrow({
        where: { companyId: COMPANY_A.id },
        select: { id: true },
      })
    ).id;
    deltaExpenseId = (
      await prisma.expense.findFirstOrThrow({
        where: { companyId: COMPANY_B.id },
        select: { id: true },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  const asNile = () => request(app.getHttpServer());

  // --- F02-T12 - role authorization ------------------------------------------
  it('F02-T12: a manager is refused an admin-only route with 403', async () => {
    const response = await asNile()
      .get('/probe/admin-only')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .expect(403);

    // 403, not 404: the caller is authenticated and the route exists. Knowing
    // that admin routes exist is not a secret, so there is no oracle to close
    // here - unlike at the row level below.
    expect(response.body.error).toBe('insufficient_role');
  });

  it('F02-T12b: the admin is refused a manager-only route - roles are not a hierarchy', async () => {
    await asNile()
      .get('/probe/manager-only')
      .set('cookie', `${COOKIE}=${adminCookie}`)
      .expect(403);
  });

  it('F02-T12c: each role reaches its own route', async () => {
    await asNile().get('/probe/manager-only').set('cookie', `${COOKIE}=${nileCookie}`).expect(200);
    await asNile().get('/probe/admin-only').set('cookie', `${COOKIE}=${adminCookie}`).expect(200);
  });

  // --- F02-T13 - cross-tenant read -------------------------------------------
  it('F02-T13: a manager reading another company record gets 404, not 403', async () => {
    const own = await asNile()
      .get(`/probe/expenses/${nileExpenseId}`)
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .expect(200);
    expect(own.body.id).toBe(nileExpenseId);

    const foreign = await asNile()
      .get(`/probe/expenses/${deltaExpenseId}`)
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .expect(404);

    const nonexistent = await asNile()
      .get(`/probe/expenses/${randomUUID()}`)
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .expect(404);

    // Byte-identical. A 403 here would confirm the row exists, turning the
    // endpoint into an enumeration oracle: company A could walk ids and learn
    // which ones are real, how many company B has, and roughly when they were
    // created (ADR-003).
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(nonexistent.body));
  });

  it('F02-T13b: the same holds for an API key caller', async () => {
    await asNile().get(`/probe/expenses/${nileExpenseId}`).set('x-api-key', nileKey).expect(200);
    await asNile().get(`/probe/expenses/${deltaExpenseId}`).set('x-api-key', nileKey).expect(404);
  });

  it('F02-T13c: isolation holds in both directions', async () => {
    await asNile()
      .get(`/probe/expenses/${nileExpenseId}`)
      .set('cookie', `${COOKIE}=${deltaCookie}`)
      .expect(404);
  });

  // --- F02-T14 - cross-tenant mutation ---------------------------------------
  it('F02-T14: a cross-tenant write is rejected and changes nothing', async () => {
    const before = await prisma.expense.findUniqueOrThrow({
      where: { id: deltaExpenseId },
      select: { merchant: true, updatedAt: true },
    });

    await asNile()
      .patch(`/probe/expenses/${deltaExpenseId}/merchant`)
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set(CSRF, '1')
      .send({ merchant: 'HIJACKED' })
      .expect(404);

    const after = await prisma.expense.findUniqueOrThrow({
      where: { id: deltaExpenseId },
      select: { merchant: true, updatedAt: true },
    });

    // Not merely "the response was 404" - the row is untouched. The tenant
    // filter is inside the UPDATE statement, so nothing was written and then
    // regretted.
    expect(after.merchant).toBe(before.merchant);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  // --- F02-T15 - caller-supplied tenant --------------------------------------
  it('F02-T15: a companyId in the body cannot change the resolved tenant', async () => {
    const response = await asNile()
      .post('/probe/whose-tenant')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set(CSRF, '1')
      .send({ companyId: COMPANY_B.id, role: 'PLATFORM_ADMIN', userId: randomUUID() })
      .expect(201);

    // The tenant comes from the principal the guard resolved, and the only
    // input to that was a verified credential.
    expect(response.body.companyId).toBe(COMPANY_A.id);
    expect(response.body.companyId).not.toBe(COMPANY_B.id);
  });

  it('F02-T15b: a companyId in a query string or header changes nothing either', async () => {
    const viaQuery = await asNile()
      .post(`/probe/whose-tenant?companyId=${COMPANY_B.id}`)
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set(CSRF, '1')
      .send({})
      .expect(201);
    expect(viaQuery.body.companyId).toBe(COMPANY_A.id);

    const viaHeader = await asNile()
      .post('/probe/whose-tenant')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set(CSRF, '1')
      .set('x-company-id', COMPANY_B.id)
      .send({})
      .expect(201);
    expect(viaHeader.body.companyId).toBe(COMPANY_A.id);
  });

  it('F02-T15c: the platform admin has no tenant, and a scoped query refuses rather than guesses', async () => {
    const response = await asNile()
      .get(`/probe/expenses/${nileExpenseId}`)
      .set('cookie', `${COOKIE}=${adminCookie}`)
      .expect(403);

    // tenantScope() throws rather than returning an empty filter. An empty
    // filter would mean either "no rows" or, far worse, "all rows".
    expect(response.body.error).toBe('tenant_required');
  });

  // --- F02-T16 - CSRF --------------------------------------------------------
  it('F02-T16: a browser mutation without the CSRF header is refused', async () => {
    const response = await asNile()
      .post('/probe/whose-tenant')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .send({})
      .expect(403);

    expect(response.body.error).toBe('csrf_header_required');
  });

  it('F02-T16b: login itself requires the header - login CSRF is a real attack', async () => {
    // A hostile page POSTing the ATTACKER's credentials would otherwise sign
    // the victim into the attacker's account, and everything they then did
    // would land there.
    await asNile()
      .post('/v1/auth/login')
      .send({ email: nileManager.email, password: nileManager.password })
      .expect(403);
  });

  it('F02-T16d: logout requires the header too', async () => {
    await asNile()
      .post('/v1/auth/logout')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .expect(403);
  });

  it('F02-T16e: safe methods need no header', async () => {
    await asNile().get('/v1/auth/me').set('cookie', `${COOKIE}=${nileCookie}`).expect(200);
  });

  it('F02-T16f: a fake API key does not buy an exemption from CSRF', async () => {
    // The CSRF guard exempts requests that PRESENT a key, because validating
    // it is authentication's job - and an invalid key is a 401 either way. So
    // the exemption cannot be used as a bypass.
    const response = await asNile()
      .post('/probe/whose-tenant')
      .set('x-api-key', 'lmz_dev_fake_0000000000000000000000000000000000')
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthenticated');
  });

  // --- F02-T30 - server-side Origin check ------------------------------------
  it('F02-T30: a mutation from a foreign Origin is refused even with the header', async () => {
    const response = await asNile()
      .post('/probe/whose-tenant')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set(CSRF, '1')
      .set('origin', 'https://evil.example')
      .send({})
      .expect(403);

    // Origin is a forbidden header name: page JavaScript cannot forge it, the
    // browser sets it. So this moves the judgement from the browser's CORS
    // implementation to our own server.
    expect(response.body.error).toBe('cross_origin_rejected');
  });

  it('F02-T30b: the application origin is accepted', async () => {
    await asNile()
      .post('/probe/whose-tenant')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set(CSRF, '1')
      .set('origin', TEST_APP_ORIGIN)
      .send({})
      .expect(201);
  });

  it('F02-T30c: no Origin at all is accepted - non-browser clients never send one', async () => {
    await asNile()
      .post('/probe/whose-tenant')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set(CSRF, '1')
      .send({})
      .expect(201);
  });

  // --- no CORS ---------------------------------------------------------------
  it('F02-T20b: the API sends no CORS headers, so a browser blocks cross-origin reads', async () => {
    const response = await asNile()
      .get('/v1/auth/me')
      .set('cookie', `${COOKIE}=${nileCookie}`)
      .set('origin', 'https://evil.example')
      .expect(200);

    // Absence is the protection. With no Access-Control-Allow-Origin the
    // browser's default - deny - stands, and the hostile page cannot read this
    // response even though the server produced it. Adding CORS could only ever
    // OPEN what is currently closed.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  // --- public routes ---------------------------------------------------------
  it('F02-T02b: a public route needs no credential, and protection is the default', async () => {
    await asNile().get('/probe/public').expect(200);
    await asNile().get('/probe/any-caller').expect(401);
  });

  // --- F02-T29 - negative control --------------------------------------------
  it('F02-T29: NEGATIVE CONTROL - without the tenant filter the isolation test would pass anything', async () => {
    // Proves F02-T13 is testing the filter rather than a coincidence. Running
    // the same lookup WITHOUT tenantScope returns company B's row to a query
    // made on company A's behalf.
    const unscoped = await prisma.expense.findFirst({
      where: { id: deltaExpenseId },
      select: { id: true, companyId: true },
    });

    expect(unscoped).not.toBeNull();
    expect(unscoped!.companyId).toBe(COMPANY_B.id);

    const scoped = await prisma.expense.findFirst({
      where: { id: deltaExpenseId, companyId: COMPANY_A.id },
      select: { id: true },
    });

    expect(scoped).toBeNull();
  });
});
