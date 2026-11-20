import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { createReviewsTestApp, login, TEST_APP_ORIGIN } from './reviews-test-app';

/**
 * F05-T01 to F05-T20 - listing, details, authorization and validation.
 *
 * The seed already provides all three shapes: an OPEN review for Nile, a
 * RESOLVED/APPROVED one for Nile, and a RESOLVED/REJECTED one for Delta. Each
 * carries `decision = REVIEW` with a different `status`, so the two-field
 * distinction is in the fixture data as well as in the code.
 */
describe('F05 review access', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const deltaManager = USERS.find((u) => u.companyId === COMPANY_B.id)!;
  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;

  let nileCookie: string;
  let deltaCookie: string;
  let adminCookie: string;

  const asManager = (cookie: string) => ({
    Cookie: cookie,
    origin: TEST_APP_ORIGIN,
    'x-limaz-client': '1',
  });

  beforeAll(async () => {
    const booted = await createReviewsTestApp();
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

  // --- F05-T01 to T03: listing --------------------------------------------
  it('F05-T01: a manager sees their own company open reviews', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/reviews')
      .set(asManager(nileCookie))
      .expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
    expect(response.body.items.every((r: { state: string }) => r.state === 'OPEN')).toBe(true);

    // Every returned review's expense belongs to this company.
    const ids = response.body.items.map((r: { id: string }) => r.id);
    const rows = await prisma.review.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.companyId === COMPANY_A.id)).toBe(true);
  });

  it('F05-T02: a company with no open reviews gets a valid empty page', async () => {
    // Delta's only seeded review is RESOLVED.
    const response = await request(app.getHttpServer())
      .get('/v1/reviews')
      .set(asManager(deltaCookie))
      .expect(200);

    // An empty LIST, not 404 and not null. "Nothing to do" is a successful
    // answer to "what do I have to do".
    expect(response.body.items).toEqual([]);
    expect(response.body.nextCursor).toBeNull();
  });

  it('F05-T03: resolved reviews are excluded from the default listing', async () => {
    const open = await request(app.getHttpServer())
      .get('/v1/reviews')
      .set(asManager(nileCookie))
      .expect(200);

    const all = await request(app.getHttpServer())
      .get('/v1/reviews?state=ALL')
      .set(asManager(nileCookie))
      .expect(200);

    expect(all.body.items.length).toBeGreaterThan(open.body.items.length);
    expect(all.body.items.some((r: { state: string }) => r.state === 'RESOLVED')).toBe(true);
    expect(open.body.items.some((r: { state: string }) => r.state === 'RESOLVED')).toBe(false);
  });

  // --- F05-T04 to T07: details --------------------------------------------
  it('F05-T04: a manager reads their own review in full', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/reviews')
      .set(asManager(nileCookie))
      .expect(200);

    const id = list.body.items[0].id as string;

    const response = await request(app.getHttpServer())
      .get(`/v1/reviews/${id}`)
      .set(asManager(nileCookie))
      .expect(200);

    expect(response.body.id).toBe(id);
    expect(response.body.state).toBe('OPEN');
    expect(response.body.resolution).toBeNull();

    // The expense carries BOTH facts: the immutable original decision and the
    // current status.
    expect(response.body.expense.decision).toBe('REVIEW');
    expect(response.body.expense.status).toBe('PENDING_REVIEW');

    expect(response.body.policySnapshot).toBeDefined();
    expect(Array.isArray(response.body.reasons)).toBe(true);
  });

  it('F05-T04b: a resolved review exposes its audit fields', async () => {
    const all = await request(app.getHttpServer())
      .get('/v1/reviews?state=RESOLVED')
      .set(asManager(nileCookie))
      .expect(200);

    const resolved = all.body.items[0];
    expect(resolved.resolution).not.toBeNull();
    expect(resolved.resolution.outcome).toBe('APPROVED');
    expect(typeof resolved.resolution.resolvedAt).toBe('string');
    expect(typeof resolved.resolution.resolvedBy.displayName).toBe('string');

    // The reviewer's NAME is enough to show who acted. Publishing their email
    // would hand every manager a directory they did not ask for.
    expect(resolved.resolution.resolvedBy.email).toBeUndefined();
  });

  it('F05-T05: an unknown review id is 404', async () => {
    await request(app.getHttpServer())
      .get('/v1/reviews/00000000-0000-7000-8000-000000000000')
      .set(asManager(nileCookie))
      .expect(404);
  });

  it('F05-T06: another company review is a tenant-scoped 404, byte-identical', async () => {
    const deltaReview = await prisma.review.findFirstOrThrow({
      where: { companyId: COMPANY_B.id },
    });

    const foreign = await request(app.getHttpServer())
      .get(`/v1/reviews/${deltaReview.id}`)
      .set(asManager(nileCookie))
      .expect(404);

    const missing = await request(app.getHttpServer())
      .get('/v1/reviews/00000000-0000-7000-8000-000000000000')
      .set(asManager(nileCookie))
      .expect(404);

    // "Not yours" and "not there" must be indistinguishable. A 403 here, or
    // any difference in the body, would confirm the row exists and turn the
    // endpoint into an enumeration oracle (ADR-003).
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(missing.body));
  });

  it('F05-T07: a review whose expense fired several rules exposes them all', async () => {
    const withHits = await prisma.review.findFirst({
      where: { companyId: COMPANY_A.id },
      include: { expense: { include: { ruleHits: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const response = await request(app.getHttpServer())
      .get(`/v1/reviews/${withHits!.id}`)
      .set(asManager(nileCookie))
      .expect(200);

    expect(response.body.reasons).toHaveLength(withHits!.expense.ruleHits.length);

    for (const reason of response.body.reasons) {
      expect(reason.code).toBeDefined();
      expect(reason.decision).toBeDefined();
      expect(reason.detail).toBeDefined();
    }
  });

  it('nothing sensitive is published by either route', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/reviews?state=ALL')
      .set(asManager(nileCookie))
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/v1/reviews/${list.body.items[0].id}`)
      .set(asManager(nileCookie))
      .expect(200);

    for (const body of [list.body, detail.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/payloadHash|keyHash|passwordHash|tokenHash/u);
      // No 64-character hex anywhere: that is what a hash looks like.
      expect(text).not.toMatch(/[0-9a-f]{64}/u);
    }
  });

  // --- F05-T08: ordering and pagination ------------------------------------
  it('F05-T08: pages are newest-first, bounded, and do not repeat rows', async () => {
    const all = await request(app.getHttpServer())
      .get('/v1/reviews?state=ALL&limit=100')
      .set(asManager(nileCookie))
      .expect(200);

    const total = all.body.items.length;
    expect(total).toBeGreaterThan(1);

    // Newest first, by (createdAt DESC, id DESC).
    const times = all.body.items.map((r: { createdAt: string }) => Date.parse(r.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // Walk it one at a time and assert every row is seen exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < total + 2; page += 1) {
      const url: string = `/v1/reviews?state=ALL&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const response = await request(app.getHttpServer())
        .get(url)
        .set(asManager(nileCookie))
        .expect(200);

      seen.push(...response.body.items.map((r: { id: string }) => r.id));
      cursor = response.body.nextCursor as string | null;

      if (!cursor) {
        break;
      }
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual(all.body.items.map((r: { id: string }) => r.id));
  });

  it('a limit above the maximum is rejected rather than silently clamped', async () => {
    // Clamping would let a client believe it asked for 10,000 and received
    // all of them, when it received 100.
    await request(app.getHttpServer())
      .get('/v1/reviews?limit=10000')
      .set(asManager(nileCookie))
      .expect(400);
  });

  it.each([
    ['not base64', 'not-a-cursor!!'],
    ['base64 without a separator', Buffer.from('nonsense').toString('base64url')],
    [
      'a bad date',
      Buffer.from('not-a-date|00000000-0000-7000-8000-000000000000').toString('base64url'),
    ],
    ['a bad uuid', Buffer.from('2026-11-20T00:00:00.000Z|nope').toString('base64url')],
  ])('an invalid cursor (%s) is a 400, not a silent reset', async (_name, cursor) => {
    // Silently starting over would make a client paging a long list loop
    // forever without ever being told why.
    const response = await request(app.getHttpServer())
      .get(`/v1/reviews?cursor=${encodeURIComponent(cursor)}`)
      .set(asManager(nileCookie))
      .expect(400);

    expect(response.body.error).toMatch(/invalid_cursor|invalid_request/u);
  });

  it('an unknown query parameter is refused', async () => {
    await request(app.getHttpServer())
      .get('/v1/reviews?companyId=' + COMPANY_B.id)
      .set(asManager(nileCookie))
      .expect(400);
  });

  // --- F05-T09 to T12: who may call ---------------------------------------
  it('F05-T09: an unauthenticated caller cannot list reviews', async () => {
    const response = await request(app.getHttpServer()).get('/v1/reviews').expect(401);
    expect(response.body.error).toBe('unauthenticated');
  });

  it('F05-T10: an invalid session is refused', async () => {
    await request(app.getHttpServer())
      .get('/v1/reviews')
      .set({ Cookie: 'limaz_session=not-a-real-token', origin: TEST_APP_ORIGIN })
      .expect(401);
  });

  it('F05-T11: a company API key cannot read or resolve reviews', async () => {
    // A valid credential of the WRONG KIND. A key authenticates a company's
    // backend; reviewing is something a PERSON is accountable for.
    const list = await request(app.getHttpServer())
      .get('/v1/reviews')
      .set('x-api-key', nileKey)
      .expect(403);

    expect(list.body.error).toBe('caller_type_not_allowed');

    const review = await prisma.review.findFirstOrThrow({ where: { state: 'OPEN' } });

    await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set('x-api-key', nileKey)
      .send({ decision: 'APPROVE' })
      .expect(403);

    const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.state).toBe('OPEN');
  });

  it('F05-T12: the platform admin cannot resolve a company review', async () => {
    const review = await prisma.review.findFirstOrThrow({ where: { state: 'OPEN' } });

    const list = await request(app.getHttpServer())
      .get('/v1/reviews')
      .set(asManager(adminCookie))
      .expect(403);

    expect(list.body.error).toBe('insufficient_role');

    const resolve = await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set(asManager(adminCookie))
      .send({ decision: 'APPROVE' })
      .expect(403);

    expect(resolve.body.error).toBe('insufficient_role');

    // Denied rather than assumed: reviewing a company's spending is that
    // company's business, and no approved contract grants an administrator
    // that authority.
    const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.state).toBe('OPEN');
    expect(after.resolvedByUserId).toBeNull();
  });

  // --- F05-T13 to T20: resolution input -----------------------------------
  it('F05-T13: resolving another company review is 404 with no mutation', async () => {
    const deltaReview = await prisma.review.findFirstOrThrow({
      where: { companyId: COMPANY_B.id },
    });
    const before = { ...deltaReview };

    await request(app.getHttpServer())
      .post(`/v1/reviews/${deltaReview.id}/resolve`)
      .set(asManager(nileCookie))
      .send({ decision: 'APPROVE' })
      .expect(404);

    const after = await prisma.review.findUniqueOrThrow({ where: { id: deltaReview.id } });
    expect(after.state).toBe(before.state);
    expect(after.outcome).toBe(before.outcome);
    expect(after.resolvedByUserId).toBe(before.resolvedByUserId);
    expect(after.resolvedAt?.toISOString()).toBe(before.resolvedAt?.toISOString());
  });

  it.each([
    ['reviewerId', { reviewerId: '00000000-0000-7000-8000-000000000000' }],
    ['companyId', { companyId: COMPANY_B.id }],
    ['resolvedAt', { resolvedAt: '2020-01-01T00:00:00.000Z' }],
    ['resolvedByUserId', { resolvedByUserId: '00000000-0000-7000-8000-000000000000' }],
    ['state', { state: 'OPEN' }],
    ['outcome', { outcome: 'REJECTED' }],
  ])('F05-T14/T15: a body carrying %s is REFUSED, not ignored', async (_name, extra) => {
    // Refusing matters more than usual here. An ignored `reviewerId` leaves
    // the caller believing they recorded who acted, and the audit trail then
    // says something nobody intended.
    const review = await prisma.review.findFirstOrThrow({ where: { state: 'OPEN' } });

    const response = await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set(asManager(nileCookie))
      .send({ decision: 'APPROVE', ...extra })
      .expect(400);

    expect(response.body.error).toBe('invalid_request');

    const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.state).toBe('OPEN');
  });

  it.each([
    ['an unknown value', { decision: 'MAYBE' }],
    ['lowercase', { decision: 'approve' }],
    ['a number', { decision: 1 }],
    ['null', { decision: null }],
  ])('F05-T16: an invalid decision (%s) is 400', async (_name, body) => {
    const review = await prisma.review.findFirstOrThrow({ where: { state: 'OPEN' } });

    await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set(asManager(nileCookie))
      .send(body)
      .expect(400);
  });

  it('F05-T17: a missing decision is 400', async () => {
    const review = await prisma.review.findFirstOrThrow({ where: { state: 'OPEN' } });

    await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set(asManager(nileCookie))
      .send({})
      .expect(400);
  });

  it('F05-T19: a malformed review id is 400, not 500 and not 404', async () => {
    // The id is unusable, which is a different fact from "there is no such
    // review". Answering 404 would hide a client bug behind a plausible
    // answer, and letting it reach PostgreSQL would be a 500 on a uuid cast.
    const response = await request(app.getHttpServer())
      .get('/v1/reviews/not-a-uuid')
      .set(asManager(nileCookie))
      .expect(400);

    expect(response.body.error).toBe('invalid_request');
  });

  it('F05-T20: resolution requires the CSRF header, per the F02 contract', async () => {
    const review = await prisma.review.findFirstOrThrow({ where: { state: 'OPEN' } });

    // A session cookie with no client header looks exactly like a cross-site
    // form submission, and is refused before authentication runs.
    const noHeader = await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set({ Cookie: nileCookie })
      .send({ decision: 'APPROVE' })
      .expect(403);

    expect(noHeader.body.error).toBe('csrf_header_required');

    const wrongOrigin = await request(app.getHttpServer())
      .post(`/v1/reviews/${review.id}/resolve`)
      .set({ Cookie: nileCookie, origin: 'https://evil.example', 'x-limaz-client': '1' })
      .send({ decision: 'APPROVE' })
      .expect(403);

    expect(wrongOrigin.body.error).toBe('cross_origin_rejected');

    const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.state).toBe('OPEN');
  });

  it('F05-T45: the review routes exist in the production module wiring', async () => {
    // Proven by behaviour: the routes answer, and they answer with the
    // guards' vocabulary rather than Nest's 404-for-unknown-route.
    const response = await request(app.getHttpServer()).get('/v1/reviews').expect(401);

    expect(response.body.error).toBe('unauthenticated');
  });
});
