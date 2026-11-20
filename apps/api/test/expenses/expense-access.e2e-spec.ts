import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, EXPENSES, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { asManager, createF06TestApp, login, TEST_APP_ORIGIN } from '../dashboard/f06-test-app';
import { resetDatabase } from '../test-db';

/**
 * F06-T06, T07, T11 to T19 and T21 - the manager's expense read endpoints.
 */
describe('F06 expense access', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const deltaManager = USERS.find((u) => u.companyId === COMPANY_B.id)!;
  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  const nileFixtures = EXPENSES.filter((e) => e.companyId === COMPANY_A.id);
  const deltaFixtures = EXPENSES.filter((e) => e.companyId === COMPANY_B.id);

  let nileCookie: string;
  let deltaCookie: string;
  let adminCookie: string;

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

  const get = (path: string, cookie: string) =>
    request(app.getHttpServer()).get(path).set(asManager(cookie));

  // --- F06-T06: own-company listing ---------------------------------------
  it('F06-T06: a manager sees exactly their own company expenses', async () => {
    const response = await get('/v1/expenses?limit=100', nileCookie).expect(200);

    const externalIds = response.body.items.map((e: { externalId: string }) => e.externalId).sort();

    expect(externalIds).toEqual(nileFixtures.map((e) => e.externalId).sort());
    expect(response.body.nextCursor).toBeNull();
  });

  it('F06-T06b: the response publishes no internal columns', async () => {
    const response = await get('/v1/expenses?limit=1', nileCookie).expect(200);
    const item = response.body.items[0];

    // payloadHash would let a caller probe whether a guessed payload matches
    // an expense (F03-T14c). companyId is an internal identifier the caller
    // already knows and does not need echoed.
    expect(item).not.toHaveProperty('payloadHash');
    expect(item).not.toHaveProperty('companyId');
    expect(item).not.toHaveProperty('policySnapshot');
  });

  // --- F06-T07: cross-tenant detail ---------------------------------------
  it("F06-T07: another company's expense answers 404, not 403", async () => {
    const deltaExpense = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_B.id },
    });

    const foreign = await get(`/v1/expenses/${deltaExpense.id}`, nileCookie).expect(404);

    const missing = await get(
      '/v1/expenses/00000000-0000-7000-8000-000000000000',
      nileCookie,
    ).expect(404);

    // Byte-identical, not merely similar. Any difference at all is an
    // enumeration oracle: it tells the caller the row exists.
    expect(foreign.body).toEqual(missing.body);
    // `statusCode` is part of every error body this application emits - the
    // shared filter adds it. Asserted explicitly rather than omitted, so a
    // future change to the error shape fails here instead of silently
    // altering a contract two other features already depend on.
    expect(foreign.body).toEqual({
      statusCode: 404,
      error: 'not_found',
      message: 'No such expense.',
    });
  });

  // --- F06-T08 to T10: who may ask ----------------------------------------
  it('F06-T08: an unauthenticated request is refused', async () => {
    await request(app.getHttpServer()).get('/v1/expenses').expect(401);
  });

  it('F06-T09: an API key cannot read the manager listing', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/expenses')
      .set('x-api-key', nileKey)
      .expect(403);

    expect(response.body.error).toBe('caller_type_not_allowed');
  });

  it('F06-T10: the platform admin does not inherit manager access', async () => {
    const list = await get('/v1/expenses', adminCookie).expect(403);
    expect(list.body.error).toBe('insufficient_role');

    const detail = await get(
      '/v1/expenses/00000000-0000-7000-8000-000000000000',
      adminCookie,
    ).expect(403);
    expect(detail.body.error).toBe('insufficient_role');
  });

  // --- F06-T11 to T13: the detail view ------------------------------------
  it('F06-T11: an expense with multiple rule hits returns every reason', async () => {
    const fixture = nileFixtures.find((e) => e.ruleHits.length > 1)!;
    expect(fixture).toBeDefined();

    const row = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id, externalId: fixture.externalId },
    });

    const response = await get(`/v1/expenses/${row.id}`, nileCookie).expect(200);

    expect(response.body.reasons.map((r: { code: string }) => r.code)).toEqual(
      fixture.ruleHits.map((h) => h.ruleCode).sort((a, b) => a.localeCompare(b)),
    );
    // Every reason carries its own evidence, not just a code.
    for (const reason of response.body.reasons) {
      expect(reason.detail).toBeTruthy();
      expect(typeof reason.detail).toBe('object');
    }
  });

  it('F06-T12: changing the policy does not change a stored expense', async () => {
    const row = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id, externalId: 'exp-1005' },
    });

    const before = await get(`/v1/expenses/${row.id}`, nileCookie).expect(200);

    await prisma.policy.update({
      where: { companyId: COMPANY_A.id },
      data: { autoApproveLimitMinor: 999_999_99, blockedCategories: ['NOTHING'] },
    });

    const after = await get(`/v1/expenses/${row.id}`, nileCookie).expect(200);

    // The snapshot is what the expense was JUDGED against, captured at
    // decision time (A7). Reading it from the live policy would make "why was
    // this flagged?" unanswerable the moment anybody edits the policy.
    expect(after.body.policySnapshot).toEqual(before.body.policySnapshot);
    expect(after.body.decision).toBe(before.body.decision);
    expect(after.body.reasons).toEqual(before.body.reasons);

    // Restore, so the ordering of tests in this file cannot matter.
    const original = COMPANY_A.policy;
    await prisma.policy.update({
      where: { companyId: COMPANY_A.id },
      data: {
        autoApproveLimitMinor: original.autoApproveLimitMinor,
        blockedCategories: [...original.blockedCategories],
      },
    });
  });

  it('F06-T13: a resolved expense keeps its original decision and shows the human outcome', async () => {
    // exp-1005 is the seeded "policy said REVIEW, a manager approved it" case.
    const row = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id, externalId: 'exp-1005' },
    });

    const response = await get(`/v1/expenses/${row.id}`, nileCookie).expect(200);

    // Three separate facts, none of which replaces another.
    expect(response.body.decision).toBe('REVIEW');
    expect(response.body.status).toBe('APPROVED');
    expect(response.body.review.state).toBe('RESOLVED');
    expect(response.body.review.outcome).toBe('APPROVED');
    expect(response.body.review.resolvedBy.displayName).toBeTruthy();
    expect(response.body.review.resolvedAt).toBeTruthy();

    // The reviewer's name, and nothing else about them.
    expect(response.body.review.resolvedBy).not.toHaveProperty('email');
    expect(response.body.review.resolvedBy).not.toHaveProperty('passwordHash');
  });

  it('F06-T13b: an open review reports no outcome rather than a default one', async () => {
    const row = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id, status: 'PENDING_REVIEW' },
    });

    const response = await get(`/v1/expenses/${row.id}`, nileCookie).expect(200);

    expect(response.body.review.state).toBe('OPEN');
    expect(response.body.review.outcome).toBeNull();
    expect(response.body.review.resolvedAt).toBeNull();
    expect(response.body.review.resolvedBy).toBeNull();
  });

  it('F06-T13c: an expense that was never flagged has no review at all', async () => {
    const row = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id, decision: 'APPROVE' },
    });

    const response = await get(`/v1/expenses/${row.id}`, nileCookie).expect(200);

    // null, not an empty object. "There was never a review" and "there is a
    // review with nothing filled in" are different facts.
    expect(response.body.review).toBeNull();
    expect(response.body.reasons).toEqual([]);
  });

  // --- F06-T14 to T16: search and filters ---------------------------------
  it('F06-T14: search is scoped to the caller company', async () => {
    // "Beans Cafe" exists in BOTH companies' fixtures, which is what makes
    // this a tenant test rather than a search test: the same search term has
    // matches on both sides of the boundary.
    //
    // (The first version of this test used "Casino Royale", which only Nile
    // has - so the search would have been scoped correctly by accident even
    // with no tenant predicate at all.)
    expect(nileFixtures.some((e) => e.merchant === 'Beans Cafe')).toBe(true);
    expect(deltaFixtures.some((e) => e.merchant === 'Beans Cafe')).toBe(true);

    const nile = await get('/v1/expenses?q=beans', nileCookie).expect(200);
    const delta = await get('/v1/expenses?q=beans', deltaCookie).expect(200);

    const nileIds = nile.body.items.map((e: { externalId: string }) => e.externalId);
    const deltaIds = delta.body.items.map((e: { externalId: string }) => e.externalId);

    expect(nileIds.length).toBeGreaterThan(0);
    expect(deltaIds.length).toBeGreaterThan(0);
    // Disjoint. Neither company can see a single one of the other's matches.
    expect(nileIds.filter((id: string) => deltaIds.includes(id))).toEqual([]);
  });

  it('F06-T14b: search matches merchant, external reference and employee reference', async () => {
    const byMerchant = await get('/v1/expenses?q=jetbrains', nileCookie).expect(200);
    const byExternal = await get('/v1/expenses?q=exp-1001', nileCookie).expect(200);
    const byEmployee = await get('/v1/expenses?q=emp-9', nileCookie).expect(200);

    // Case-insensitive on the merchant: the fixture is "JetBrains".
    expect(byMerchant.body.items).toHaveLength(1);
    expect(byMerchant.body.items[0].merchant).toBe('JetBrains');

    expect(byExternal.body.items).toHaveLength(1);
    expect(byExternal.body.items[0].externalId).toBe('exp-1001');

    expect(byEmployee.body.items.length).toBeGreaterThan(0);
    expect(
      byEmployee.body.items.every((e: { employeeId: string }) => e.employeeId === 'emp-9'),
    ).toBe(true);
  });

  it('F06-T15: the status filter returns exactly that status', async () => {
    const response = await get('/v1/expenses?status=PENDING_REVIEW', nileCookie).expect(200);

    const want = nileFixtures.filter((e) => e.status === 'PENDING_REVIEW');

    expect(response.body.items).toHaveLength(want.length);
    expect(response.body.items.every((e: { status: string }) => e.status === 'PENDING_REVIEW')).toBe(
      true,
    );
  });

  it('F06-T15b: the decision filter is not the status filter', async () => {
    const flagged = await get('/v1/expenses?decision=REVIEW&limit=100', nileCookie).expect(200);
    const pending = await get('/v1/expenses?status=PENDING_REVIEW&limit=100', nileCookie).expect(
      200,
    );

    // The whole point of having both. "Flagged by the policy" is a strictly
    // larger set than "still waiting", because some flagged expenses have
    // already been resolved.
    expect(flagged.body.items.length).toBeGreaterThan(pending.body.items.length);
    expect(flagged.body.items.every((e: { decision: string }) => e.decision === 'REVIEW')).toBe(
      true,
    );
  });

  it('F06-T16: combined filters narrow rather than replace each other', async () => {
    const response = await get(
      '/v1/expenses?decision=REVIEW&status=APPROVED&limit=100',
      nileCookie,
    ).expect(200);

    const want = nileFixtures.filter((e) => e.decision === 'REVIEW' && e.status === 'APPROVED');

    expect(want.length).toBeGreaterThan(0);
    expect(response.body.items).toHaveLength(want.length);
    expect(
      response.body.items.every(
        (e: { decision: string; status: string }) =>
          e.decision === 'REVIEW' && e.status === 'APPROVED',
      ),
    ).toBe(true);
  });

  it('F06-T16b: a search term and a filter apply together, not instead of each other', async () => {
    const response = await get('/v1/expenses?q=casino&status=APPROVED', nileCookie).expect(200);

    // Every seeded Casino Royale expense is REJECTED, so this must be empty.
    // If `q` and the cursor/filters collided under one `OR` key, this would
    // return the rejected rows and look like a working search.
    expect(response.body.items).toEqual([]);
  });

  it('F06-T16c: the category filter is normalised to uppercase', async () => {
    const lower = await get('/v1/expenses?category=food', nileCookie).expect(200);
    const upper = await get('/v1/expenses?category=FOOD', nileCookie).expect(200);

    expect(lower.body.items.length).toBeGreaterThan(0);
    expect(lower.body).toEqual(upper.body);
  });

  // --- F06-T17: validation ------------------------------------------------
  it('F06-T17: an unknown query parameter is refused, not ignored', async () => {
    const response = await get('/v1/expenses?companyId=' + COMPANY_B.id, nileCookie).expect(400);

    // Silently ignoring it would leave the caller believing it was honoured.
    expect(response.body.error).toBe('invalid_request');
  });

  it('F06-T17b: a malformed cursor is 400, not a silent reset to page one', async () => {
    const response = await get('/v1/expenses?cursor=not-a-cursor', nileCookie).expect(400);

    expect(response.body.error).toBe('invalid_cursor');
  });

  it('F06-T17c: an out-of-range limit and an invalid enum are refused', async () => {
    await get('/v1/expenses?limit=0', nileCookie).expect(400);
    await get('/v1/expenses?limit=101', nileCookie).expect(400);
    await get('/v1/expenses?limit=abc', nileCookie).expect(400);
    await get('/v1/expenses?status=MAYBE', nileCookie).expect(400);
    await get('/v1/expenses?decision=PROBABLY', nileCookie).expect(400);
  });

  it('F06-T17d: a malformed expense id is 400, not 404 and not 500', async () => {
    const response = await get('/v1/expenses/not-a-uuid', nileCookie).expect(400);

    // 400 because the id is UNUSABLE, which is a different fact from "there
    // is no such expense". A 404 here would hide a client bug.
    expect(response.body.error).toBe('invalid_request');
  });

  // --- F06-T18 / T19: pagination ------------------------------------------
  it('F06-T18: the page size is bounded and defaults to a bounded value', async () => {
    const defaulted = await get('/v1/expenses', nileCookie).expect(200);

    // No unbounded response: the default is a page size, not "everything".
    expect(defaulted.body.items.length).toBeLessThanOrEqual(25);
    await get('/v1/expenses?limit=101', nileCookie).expect(400);
  });

  it('F06-T19: paging with limit=1 yields every row exactly once, in order', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 50; page += 1) {
      const url: string = `/v1/expenses?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await get(url, nileCookie).expect(200);

      seen.push(...response.body.items.map((e: { externalId: string }) => e.externalId));
      cursor = response.body.nextCursor;

      if (!cursor) {
        break;
      }
    }

    // Exactly once each - no duplicate, nothing missing.
    expect([...seen].sort()).toEqual(nileFixtures.map((e) => e.externalId).sort());
    expect(new Set(seen).size).toBe(seen.length);

    // And in the documented order: spentAt descending.
    const byDate = [...nileFixtures]
      .sort((a, b) => b.spentAt.getTime() - a.spentAt.getTime())
      .map((e) => e.externalId);
    expect(seen).toEqual(byDate);
  });

  it('F06-T19b: paging still works when the cursor row stops matching the filter', async () => {
    const first = await get('/v1/expenses?limit=1&decision=APPROVE', nileCookie).expect(200);
    const cursor = first.body.nextCursor as string;
    const firstId = first.body.items[0].id as string;

    expect(cursor).toBeTruthy();

    // Move the cursor row out of the filtered set, behind the reader's back.
    //
    // Both columns change together, because `expenses_decision_status_check`
    // refuses `decision = REJECT` with `status = APPROVED`. The first version
    // of this test updated only `decision` and the database rejected it -
    // which is the constraint doing exactly its job.
    await prisma.expense.update({
      where: { id: firstId },
      data: { decision: 'REJECT', status: 'REJECTED' },
    });

    // The cursor is compared as a VALUE, never looked up as a row, so the
    // next page is still correct. Prisma's own `cursor` option does a row
    // lookup and would have returned nothing here.
    const second = await get(
      `/v1/expenses?limit=1&decision=APPROVE&cursor=${encodeURIComponent(cursor)}`,
      nileCookie,
    ).expect(200);

    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(firstId);

    await prisma.expense.update({
      where: { id: firstId },
      data: { decision: 'APPROVE', status: 'APPROVED' },
    });
  });

  // --- F06-T21: submission is untouched -----------------------------------
  it('F06-T21: POST /v1/expenses still works for an API key', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send({
        externalId: `f06-regression-${Date.now()}`,
        employeeId: 'emp-f06',
        amount: 1_000,
        currency: 'SAR',
        merchant: 'Regression Check',
        category: 'OFFICE',
        spentAt: new Date().toISOString(),
      })
      .expect(201);

    expect(response.body.decision).toBe('APPROVE');
    expect(response.body.duplicate).toBe(false);

    // And the manager can immediately read what the integration submitted.
    const listed = await get(`/v1/expenses?q=${response.body.externalId}`, nileCookie).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].id).toBe(response.body.id);

    await prisma.expense.delete({ where: { id: response.body.id } });
  });

  it('F06-T21b: a manager session still cannot submit an expense', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set(asManager(nileCookie))
      .send({
        externalId: 'should-not-exist',
        employeeId: 'emp-1',
        amount: 100,
        currency: 'SAR',
        merchant: 'Nope',
        category: 'OFFICE',
        spentAt: new Date().toISOString(),
      })
      .expect(403);

    // The two methods on this controller accept disjoint callers, enforced
    // per handler. Adding GET routes must not have widened POST.
    expect(response.body.error).toBe('caller_type_not_allowed');
  });

  it('F06-T21c: the GET routes require the session origin rules the app already enforces', async () => {
    // A GET is not state-changing, so CsrfGuard does not apply - but the
    // session must still be a real one. Asserted so a future change that
    // makes reads public would fail here rather than in production.
    await request(app.getHttpServer())
      .get('/v1/expenses')
      .set({ Cookie: 'limaz_session=not-a-real-token', origin: TEST_APP_ORIGIN })
      .expect(401);
  });
});
