import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { asUser, login, TEST_APP_ORIGIN } from '../admin/f08-test-app';
import { resetDatabase } from '../test-db';
import { createF12TestApp, type F12TestApp } from './f12-test-app';

/**
 * F12 - the sandbox payment simulator.
 *
 * The claims:
 *
 *   - it DELIVERS. Every simulation is a real signed HTTP request to the real
 *     webhook endpoint, which runs the real verifier
 *   - the failure presets genuinely fail - nothing is disabled anywhere
 *   - it is platform-admin only, AND it does not exist when the flag is off
 *   - no signing secret ever leaves the server
 */
describe('F12 payment simulator', () => {
  let booted: F12TestApp;
  let app: INestApplication;
  let prisma: PrismaClient;

  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
  const manager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const apiKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  let adminCookie: string;
  let managerCookie: string;

  beforeAll(async () => {
    booted = await createF12TestApp({ sandboxEnabled: true });
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    adminCookie = await login(app, admin.email, admin.password);
    managerCookie = await login(app, manager.email, manager.password);

    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${COMPANY_A.id}/webhook-integration`)
      .set(asUser(adminCookie))
      .expect(200);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await booted?.app.close();
  });

  const simulate = (body: object, cookie = adminCookie) =>
    request(app.getHttpServer())
      .post('/v1/admin/simulator/payments')
      .set(asUser(cookie))
      .send(body);

  /**
   * Drains the whole inbox.
   *
   * `drainOne()` claims the OLDEST due event, not the one this test just
   * created - so a single call here processed a previous case's event and the
   * assertion read as 'the simulator did not deliver'. Bounded, so a bug
   * cannot hang the suite.
   */
  async function drain(limit = 50): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      if ((await booted.worker.drainOne()) === null) {
        return;
      }
    }

    throw new Error(`the inbox did not drain within ${limit} events`);
  }

  const payment = (overrides: object = {}) => ({
    companyId: COMPANY_A.id,
    cardholderId: `emp-sim-${Math.random().toString(36).slice(2, 8)}`,
    merchant: 'City Taxi',
    category: 'TRANSPORT',
    amount: 12_500,
    ...overrides,
  });

  // ===========================================================================
  // It really delivers
  // ===========================================================================

  it('F12-T100: a valid simulation reaches the real endpoint and is accepted', async () => {
    const response = await simulate(payment()).expect(201);

    expect(response.body.delivery.status).toBe(202);
    expect(response.body.delivery.body.status).toBe('ACCEPTED');
    expect(typeof response.body.eventId).toBe('string');

    // The event is in the inbox, authenticated as company A.
    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: response.body.eventId },
    });

    expect(stored.companyId).toBe(COMPANY_A.id);
    expect(stored.eventType).toBe('transaction.settled');
  });

  it('F12-T101: the simulated event becomes a real expense', async () => {
    const response = await simulate(payment({ amount: 88_800 })).expect(201);

    await drain();

    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: response.body.eventId },
    });

    expect(stored.status).toBe('PROCESSED');

    const expense = await prisma.expense.findUniqueOrThrow({
      where: { id: stored.expenseId! },
      include: { review: true },
    });

    expect(expense.source).toBe('CARD_WEBHOOK');
    expect(expense.companyId).toBe(COMPANY_A.id);
    expect(expense.decision).toBe('REVIEW');
    expect(expense.review).not.toBeNull();
  });

  it('F12-T102: the currency comes from the company, not the caller', async () => {
    // There is no currency field in the request at all. A simulator that
    // could send a mismatched one would only ever demonstrate a 422.
    const response = await simulate(payment()).expect(201);

    expect((response.body.requestBody as { data: { currency: string } }).data.currency).toBe(
      COMPANY_A.currency,
    );

    await simulate(payment({ currency: 'USD' })).expect(400);
  });

  it('F12-T103: no signing secret appears in the response, anywhere', async () => {
    const response = await simulate(payment()).expect(201);

    const serialised = JSON.stringify(response.body);

    expect(serialised).not.toContain('whsec_');
    expect(serialised).not.toContain('signingSecret');
    expect(serialised).not.toContain('secretCiphertext');
  });

  // ===========================================================================
  // The failure presets genuinely fail
  // ===========================================================================

  it('F12-T110: the invalid-signature preset is refused by the real verifier', async () => {
    const response = await simulate(payment({ mode: 'INVALID_SIGNATURE' })).expect(201);

    // 201 from the SIMULATOR - the simulation ran. 401 from the webhook
    // endpoint - the signature was refused. Those are different statements
    // and the shape keeps them apart.
    expect(response.body.delivery.status).toBe(401);
    expect(response.body.delivery.body.error).toBe('webhook_signature_invalid');
    expect(response.body.eventId).toBeNull();

    expect(
      await prisma.webhookEvent.count({
        where: { providerEventId: response.body.providerEventId },
      }),
    ).toBe(0);
  });

  it('F12-T111: the expired-signature preset is refused by the real verifier', async () => {
    const response = await simulate(payment({ mode: 'EXPIRED_SIGNATURE' })).expect(201);

    expect(response.body.delivery.status).toBe(401);
    expect(response.body.eventId).toBeNull();
  });

  it('F12-T112: a refused simulation creates no expense', async () => {
    // Settle everything already in flight first, so `before` is a stable
    // number rather than whatever a previous case happened to leave pending.
    await drain();

    const before = await prisma.expense.count({ where: { source: 'CARD_WEBHOOK' } });

    await simulate(payment({ mode: 'INVALID_SIGNATURE' })).expect(201);
    await simulate(payment({ mode: 'EXPIRED_SIGNATURE' })).expect(201);

    await drain();

    expect(await prisma.expense.count({ where: { source: 'CARD_WEBHOOK' } })).toBe(before);
  });

  // ===========================================================================
  // Replay and conflict
  // ===========================================================================

  it('F12-T120: the replay preset redelivers the stored event, not a new one', async () => {
    const first = await simulate(payment({ amount: 7_000 })).expect(201);
    const providerEventId = first.body.providerEventId;

    const replay = await simulate(
      payment({ replayOf: providerEventId, amount: 999_999 }),
    ).expect(201);

    // The amount above is deliberately different and deliberately ignored: a
    // replay re-sends what was stored. If the form fields were used instead,
    // this would be a 409 rather than a duplicate - which is exactly how the
    // first version of this preset behaved (AI_LOG 56).
    expect(replay.body.delivery.status).toBe(202);
    expect(replay.body.delivery.body.status).toBe('DUPLICATE');
    expect(replay.body.eventId).toBe(first.body.eventId);

    expect(await prisma.webhookEvent.count({ where: { providerEventId } })).toBe(1);
  });

  it('F12-T121: replaying an event that was never received is refused clearly', async () => {
    const response = await simulate(payment({ replayOf: 'evt_never_seen' })).expect(422);

    expect(response.body.error).toBe('event_not_found');
  });

  it('F12-T122: the same event id with a different payment is a conflict', async () => {
    const first = await simulate(payment({ amount: 5_000 })).expect(201);

    const conflicting = await simulate(
      payment({ eventId: first.body.providerEventId, amount: 6_000 }),
    ).expect(201);

    expect(conflicting.body.delivery.status).toBe(409);
    expect(conflicting.body.delivery.body.error).toBe('event_payload_conflict');
  });

  // ===========================================================================
  // Who may use it
  // ===========================================================================

  it('F12-T130: a company manager is refused', async () => {
    const response = await simulate(payment(), managerCookie).expect(403);

    expect(response.body.error).toBe('insufficient_role');
  });

  it('F12-T131: a company API key is refused for its kind', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/admin/simulator/payments')
      .set('x-api-key', apiKey)
      .send(payment())
      .expect(403);

    expect(response.body.error).toBe('caller_type_not_allowed');
  });

  it('F12-T132: an unauthenticated caller is refused', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/simulator/payments')
      .set('origin', TEST_APP_ORIGIN)
      .set('x-limaz-client', '1')
      .send(payment())
      .expect(401);
  });

  it('F12-T133: CSRF protection applies to the simulator', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/simulator/payments')
      .set('Cookie', adminCookie)
      .set('origin', TEST_APP_ORIGIN)
      .send(payment())
      .expect(403);

    await request(app.getHttpServer())
      .post('/v1/admin/simulator/payments')
      .set('Cookie', adminCookie)
      .set('origin', 'https://evil.example')
      .set('x-limaz-client', '1')
      .send(payment())
      .expect(403);
  });

  it('F12-T134: there is no destination parameter to override', async () => {
    // `.strict()`, so an attempt to aim the signed POST somewhere else is a
    // 400 rather than a field that is parsed and ignored. Without this the
    // simulator would be an authenticated SSRF primitive.
    for (const field of ['url', 'destination', 'endpoint', 'target', 'webhookUrl']) {
      await simulate(payment({ [field]: 'http://169.254.169.254/latest/meta-data/' })).expect(
        400,
      );
    }
  });

  it('F12-T135: a company without an integration is refused clearly', async () => {
    const response = await simulate(payment({ companyId: COMPANY_B.id })).expect(422);

    expect(response.body.error).toBe('integration_not_configured');
  });

  it('F12-T136: an unknown company is a 404', async () => {
    await simulate(payment({ companyId: '01930000-0000-7000-8000-000000000999' })).expect(404);
  });

  // ===========================================================================
  // The event history
  // ===========================================================================

  it('F12-T140: the history lists real events, filtered and paginated', async () => {
    const all = await request(app.getHttpServer())
      .get('/v1/admin/webhook-events?limit=5')
      .set(asUser(adminCookie))
      .expect(200);

    expect(all.body.items.length).toBeGreaterThan(0);
    expect(all.body.items.length).toBeLessThanOrEqual(5);

    const filtered = await request(app.getHttpServer())
      .get(`/v1/admin/webhook-events?companyId=${COMPANY_B.id}`)
      .set(asUser(adminCookie))
      .expect(200);

    expect(filtered.body.items).toEqual([]);

    const byStatus = await request(app.getHttpServer())
      .get('/v1/admin/webhook-events?status=PROCESSED')
      .set(asUser(adminCookie))
      .expect(200);

    expect(byStatus.body.items.every((e: { status: string }) => e.status === 'PROCESSED')).toBe(
      true,
    );
  });

  it('F12-T141: the history never carries a secret or a payload hash', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/admin/webhook-events')
      .set(asUser(adminCookie))
      .expect(200);

    const serialised = JSON.stringify(response.body);

    expect(serialised).not.toContain('whsec_');
    expect(serialised).not.toContain('payloadHash');
    expect(serialised).not.toContain('payload');
    expect(serialised).not.toContain('x-limaz-signature');
  });

  it('F12-T142: a manager cannot read the event history', async () => {
    await request(app.getHttpServer())
      .get('/v1/admin/webhook-events')
      .set(asUser(managerCookie))
      .expect(403);
  });
});

/**
 * The same surface with the sandbox flag OFF.
 *
 * A separate application, because the flag is read at construction - which is
 * the property that makes it a deployment decision rather than a request-time
 * one.
 */
describe('F12 payment simulator, disabled', () => {
  let booted: F12TestApp;
  let adminCookie: string;

  beforeAll(async () => {
    booted = await createF12TestApp({ sandboxEnabled: false });

    await resetDatabase(booted.prisma);
    await seed(booted.prisma);

    const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
    adminCookie = await login(booted.app, admin.email, admin.password);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(booted.prisma);
    await booted?.app.close();
  });

  it('F12-T150: the simulator reports itself disabled', async () => {
    const response = await request(booted.app.getHttpServer())
      .get('/v1/admin/simulator')
      .set(asUser(adminCookie))
      .expect(200);

    expect(response.body.enabled).toBe(false);
  });

  it('F12-T151: a genuine administrator still cannot deliver a synthetic event', async () => {
    // Enforced in the SERVICE, not by hiding a navigation link. 404 rather
    // than 403: a deployment without a sandbox should not advertise that the
    // feature exists.
    const response = await request(booted.app.getHttpServer())
      .post('/v1/admin/simulator/payments')
      .set(asUser(adminCookie))
      .send({
        companyId: COMPANY_A.id,
        cardholderId: 'emp-1',
        merchant: 'City Taxi',
        category: 'TRANSPORT',
        amount: 1_000,
      })
      .expect(404);

    expect(response.body.error).toBe('not_found');

    expect(await booted.prisma.webhookEvent.count()).toBe(0);
  });

  it('F12-T152: the real webhook endpoint is unaffected by the flag', async () => {
    // The sandbox is a demonstration tool. Turning it off must not turn off
    // the integration a real provider uses.
    await request(booted.app.getHttpServer())
      .post('/v1/webhooks/card-transactions')
      .send({})
      .expect(401);
  });
});
