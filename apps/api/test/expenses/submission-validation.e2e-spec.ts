import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { MAX_AMOUNT_MINOR } from '../../src/expenses/dto/submit-expense.dto';
import { resetDatabase } from '../test-db';
import { createExpensesTestApp, TEST_APP_ORIGIN } from './expenses-test-app';

/**
 * F03-T02 to F03-T12 - validation, authentication and tenant derivation.
 *
 * The split these tests exist to prove:
 *
 *   400  the request is malformed. True today and in ninety days.
 *   422  the request is well formed but its CONTENT is not acceptable to this
 *        company right now - the currency (A3) or the age (A4).
 *
 * That boundary is what makes F03-T25 possible: shape validation is
 * time-independent, so a retry of an old expense still parses and can reach
 * the idempotency check.
 */
describe('F03 expense submission validation', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const manager = USERS.find((u) => u.companyId === COMPANY_A.id)!;

  /** A body that is valid in every respect, varied per test. */
  const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    externalId: `exp-${Math.random().toString(36).slice(2, 10)}`,
    employeeId: 'emp-7',
    amount: 12_500,
    currency: 'SAR',
    merchant: 'City Taxi',
    category: 'TRANSPORT',
    spentAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  });

  const post = (body: Record<string, unknown>, key: string = nileKey) =>
    request(app.getHttpServer()).post('/v1/expenses').set('x-api-key', key).send(body);

  beforeAll(async () => {
    const booted = await createExpensesTestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  // --- F03-T01 (orchestration only; the DECISION is deferred to F04) --------
  it('F03-T01: a valid expense is persisted exactly once', async () => {
    const body = valid({ externalId: 'exp-t01' });

    const response = await post(body).expect(201);

    expect(response.body.externalId).toBe('exp-t01');
    expect(response.body.duplicate).toBe(false);
    expect(response.body.amountMinor).toBe(12_500);

    const rows = await prisma.expense.findMany({ where: { externalId: 'exp-t01' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(COMPANY_A.id);
    // The payload hash is stored, and is never published to the caller: it
    // would let someone probe whether a guessed payload matches a stored one.
    expect(rows[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(response.body.payloadHash).toBeUndefined();
  });

  it('F03-T01b: the policy snapshot is captured at decision time (A7)', async () => {
    const response = await post(valid({ externalId: 'exp-t01b' })).expect(201);

    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: response.body.id as string },
    });

    // Only the fields that affect a decision, so two expenses judged under
    // identical settings produce identical snapshots.
    expect(row.policySnapshot).toEqual({
      autoApproveLimitMinor: COMPANY_A.policy.autoApproveLimitMinor,
      frequencyMaxCount: COMPANY_A.policy.frequencyMaxCount,
      frequencyWindowMinutes: COMPANY_A.policy.frequencyWindowMinutes,
      blockedCategories: COMPANY_A.policy.blockedCategories,
    });
  });

  // --- F03-T02 / T03: shape ------------------------------------------------
  it.each([
    ['externalId', { externalId: undefined }],
    ['employeeId', { employeeId: undefined }],
    ['amount', { amount: undefined }],
    ['currency', { currency: undefined }],
    ['merchant', { merchant: undefined }],
    ['category', { category: undefined }],
    ['spentAt', { spentAt: undefined }],
  ])('F03-T02: a missing %s is a 400', async (field, override) => {
    const body = valid(override);
    delete body[field];

    const response = await post(body).expect(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.message).toContain(field);
  });

  it.each([
    ['amount as a string', { amount: '12500' }],
    ['merchant as a number', { merchant: 42 }],
    ['spentAt as a number', { spentAt: 1_763_629_200_000 }],
    ['currency as null', { currency: null }],
    ['employeeId as an object', { employeeId: { id: 'emp-7' } }],
  ])('F03-T03: %s is a 400', async (_name, override) => {
    await post(valid(override)).expect(400);
  });

  // --- F03-T04 / T05 / T06: money ------------------------------------------
  it.each([
    ['zero', 0],
    ['negative', -1],
  ])('F03-T04: a %s amount is a 400', async (_name, amount) => {
    const response = await post(valid({ amount })).expect(400);
    expect(response.body.message).toContain('greater than zero');
  });

  it('F03-T05: a decimal amount is refused, never rounded', async () => {
    // Rounding would change the value of money. 125.5 minor units is not a
    // number of minor units at all, and guessing which side to round to is a
    // decision no service should take on a caller's behalf (ADR-005).
    const response = await post(valid({ amount: 125.5 })).expect(400);
    expect(response.body.message).toContain('integer');

    const rows = await prisma.expense.count({ where: { amountMinor: 126 } });
    expect(rows).toBe(0);
  });

  it('F03-T06: an amount above the int4 range is a 400, not a database error', async () => {
    // Caught in validation, so the caller gets a clear 400 instead of a 500
    // from PostgreSQL rejecting the insert.
    const response = await post(valid({ amount: MAX_AMOUNT_MINOR + 1 })).expect(400);
    expect(response.body.error).toBe('invalid_request');

    // And the boundary itself is accepted.
    await post(valid({ externalId: 'exp-t06-max', amount: MAX_AMOUNT_MINOR })).expect(201);
  });

  // --- F03-T07: timestamps -------------------------------------------------
  it.each([
    ['not a date', 'yesterday'],
    ['no timezone offset', '2026-11-20T09:15:00'],
    ['an impossible month', '2026-13-01T09:15:00Z'],
    ['an impossible day', '2026-02-30T09:15:00Z'],
    ['empty', ''],
  ])('F03-T07: a spentAt that is %s is a 400', async (_name, spentAt) => {
    await post(valid({ spentAt })).expect(400);
  });

  // --- F03-T08: A4 window, a BUSINESS rule, so 422 -------------------------
  it('F03-T08: a spentAt older than 90 days is a 422', async () => {
    const response = await post(
      valid({ spentAt: new Date(Date.now() - 91 * 24 * 3_600_000).toISOString() }),
    ).expect(422);

    expect(response.body.error).toBe('spent_at_too_old');
  });

  it('F03-T08b: a spentAt more than five minutes ahead is a 422', async () => {
    const response = await post(
      valid({ spentAt: new Date(Date.now() + 6 * 60_000).toISOString() }),
    ).expect(422);

    expect(response.body.error).toBe('spent_at_in_future');
  });

  it('F03-T08c: a spentAt a few minutes ahead is accepted, for clock skew', async () => {
    await post(
      valid({ externalId: 'exp-t08c', spentAt: new Date(Date.now() + 60_000).toISOString() }),
    ).expect(201);
  });

  // --- F03-T09: A3 currency ------------------------------------------------
  it('F03-T09: a currency the company does not use is a 422', async () => {
    const response = await post(valid({ currency: 'USD' })).expect(422);

    expect(response.body.error).toBe('currency_mismatch');
    // The message names both currencies; neither is a secret, and the caller
    // cannot fix the request without knowing which one is expected.
    expect(response.body.message).toContain('SAR');
  });

  it('F03-T09b: a malformed currency is a 400, not a 422', async () => {
    // "SARS" is not a currency code at all - that is shape, not policy.
    await post(valid({ currency: 'SARS' })).expect(400);
  });

  // --- F03-T10 / T11: authentication and caller type -----------------------
  it('F03-T10: a request with no credential at all is refused before authentication', async () => {
    // 403, not 401, and that is deliberate. CsrfGuard runs FIRST - it has to,
    // because login is @Public() and a later CSRF check would skip login
    // entirely (F02-T16b). A POST carrying neither an API key nor the browser
    // client header looks exactly like a cross-site form submission and is
    // refused there, before any credential is examined.
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .send(valid())
      .expect(403);

    expect(response.body.error).toBe('csrf_header_required');
  });

  it('F03-T10a: past the CSRF layer, a missing API key is a 401', async () => {
    // The 401 path, reached by shaping the request as a browser one. This is
    // what proves authentication is genuinely required rather than merely
    // shadowed by the guard standing in front of it.
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-limaz-client', '1')
      .set('origin', TEST_APP_ORIGIN)
      .send(valid())
      .expect(401);

    expect(response.body.error).toBe('unauthenticated');
  });

  it('F03-T10b: an unknown API key is a 401', async () => {
    await post(valid(), 'lmz_dev_definitely_not_a_real_key_000000000000').expect(401);
  });

  it('F03-T11: a manager session cannot submit an expense', async () => {
    // A valid credential of the WRONG KIND. An expense is submitted by a
    // company's backend; a person doing it through the dashboard would bypass
    // the integration their company actually runs.
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('origin', TEST_APP_ORIGIN)
      .set('x-limaz-client', '1')
      .send({ email: manager.email, password: manager.password })
      .expect(200);

    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const token = setCookie[0]!.split(';')[0]!;

    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('origin', TEST_APP_ORIGIN)
      .set('x-limaz-client', '1')
      .set('Cookie', token)
      .send(valid({ externalId: 'exp-t11' }))
      .expect(403);

    // A specific code, not a generic 'forbidden': the caller IS authenticated
    // and the credential IS valid - it is the kind of caller that is wrong.
    expect(response.body.error).toBe('caller_type_not_allowed');

    const rows = await prisma.expense.count({ where: { externalId: 'exp-t11' } });
    expect(rows).toBe(0);
  });

  // --- F03-T12: the tenant cannot be named by the caller -------------------
  it('F03-T12: a body carrying companyId is refused outright', async () => {
    // `.strict()` means this is not "ignored" - it is REJECTED. Ignoring an
    // unknown field leaves the caller believing it was honoured.
    //
    // The seed gives company B expenses of its own, so the assertion is that
    // the count did not CHANGE. "Expect zero" would have been a weaker test
    // that happened to pass only because the table was empty.
    const before = await prisma.expense.count({ where: { companyId: COMPANY_B.id } });

    const response = await post(valid({ companyId: COMPANY_B.id })).expect(400);
    expect(response.body.error).toBe('invalid_request');

    const after = await prisma.expense.count({ where: { companyId: COMPANY_B.id } });
    expect(after).toBe(before);
  });

  it.each([['decision'], ['status'], ['payloadHash'], ['id'], ['receivedAt']])(
    'F03-T12b: a body carrying %s is refused',
    async (field) => {
      await post(valid({ [field]: 'APPROVE' })).expect(400);
    },
  );

  it('F03-T12c: the stored company is the key holder, whatever was sent', async () => {
    const response = await post(valid({ externalId: 'exp-t12c' })).expect(201);

    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: response.body.id as string },
    });

    expect(row.companyId).toBe(COMPANY_A.id);
  });

  // --- identifier normalisation must not merge identities ------------------
  it.each([
    ['externalId with a trailing space', { externalId: 'exp-space ' }],
    ['externalId with a leading space', { externalId: ' exp-space' }],
    ['employeeId with a trailing space', { employeeId: 'emp-7 ' }],
  ])('%s is refused rather than trimmed', async (_name, override) => {
    // Trimming would MERGE two distinct caller identities: the caller would
    // receive another record's decision with nothing to indicate it. A 400
    // they can fix is strictly better than a silent merge they cannot see.
    const response = await post(valid(override)).expect(400);
    expect(response.body.message).toContain('whitespace');
  });

  it('an externalId containing a control character is refused', async () => {
    await post(valid({ externalId: 'exp\u0000-null' })).expect(400);
  });

  it('two externalIds differing only in case are two different expenses', async () => {
    await post(valid({ externalId: 'exp-CASE' })).expect(201);
    await post(valid({ externalId: 'exp-case' })).expect(201);

    const rows = await prisma.expense.findMany({
      where: { companyId: COMPANY_A.id, externalId: { in: ['exp-CASE', 'exp-case'] } },
    });

    expect(rows).toHaveLength(2);
  });

  // --- unknown fields ------------------------------------------------------
  it('an unknown field is refused, not silently dropped', async () => {
    await post(valid({ notAField: 'x' })).expect(400);
  });

  it('whitespace-only strings are refused', async () => {
    await post(valid({ merchant: '   ' })).expect(400);
    await post(valid({ category: '   ' })).expect(400);
  });

  it('a non-object body does not produce a 500', async () => {
    await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .set('content-type', 'application/json')
      .send('"just a string"')
      .expect(400);
  });
});
