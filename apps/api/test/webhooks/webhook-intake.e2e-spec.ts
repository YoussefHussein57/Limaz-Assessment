import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { asUser, login } from '../admin/f08-test-app';
import { resetDatabase } from '../test-db';
import { cardEvent, deliver, sign } from './webhook-client';
import { createF12TestApp, type F12TestApp } from './f12-test-app';
import { WEBHOOK_PATH } from './webhook-path';

/**
 * F12 - card webhook authentication and durable acceptance.
 *
 * The claims this suite supports:
 *
 *   - the signature is really checked, over the RAW bytes, in constant time
 *   - the company comes from the integration whose secret verified, never
 *     from the body
 *   - a 2xx means the event is committed, not that an expense exists
 *   - a redelivery creates nothing; a reused id with a different payment is
 *     refused
 */
describe('F12 webhook intake', () => {
  let booted: F12TestApp;
  let app: INestApplication;
  let prisma: PrismaClient;

  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;

  let adminCookie: string;

  /** Company A's integration - the one most cases use. */
  let deliveryId: string;
  let secret: string;

  /** Company B's, for the cross-tenant cases. */
  let otherDeliveryId: string;
  let otherSecret: string;

  beforeAll(async () => {
    booted = await createF12TestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    adminCookie = await login(app, admin.email, admin.password);

    const a = await provision(COMPANY_A.id);
    deliveryId = a.deliveryId;
    secret = a.secret;

    const b = await provision(COMPANY_B.id);
    otherDeliveryId = b.deliveryId;
    otherSecret = b.secret;
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await booted?.app.close();
  });

  async function provision(companyId: string): Promise<{ deliveryId: string; secret: string }> {
    const response = await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/webhook-integration`)
      .set(asUser(adminCookie))
      .expect(200);

    return {
      deliveryId: response.body.integration.deliveryId,
      secret: response.body.signingSecret,
    };
  }

  const send = (event: unknown, overrides = {}) =>
    deliver(app, deliveryId, secret, event, overrides);

  // ===========================================================================
  // Provisioning
  // ===========================================================================

  it('F12-T01: provisioning returns the secret once, with no-store', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/admin/companies/${COMPANY_A.id}/webhook-integration`)
      .set(asUser(adminCookie))
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);

    // Replacing it keeps the delivery id and advances the version: the
    // provider is already configured with the id, so changing it would turn a
    // secret rotation into a full re-integration.
    expect(response.body.integration.deliveryId).toBe(deliveryId);
    expect(response.body.integration.secretVersion).toBeGreaterThan(1);

    // Put the old secret back in force for the rest of the suite.
    const restored = await provision(COMPANY_A.id);
    deliveryId = restored.deliveryId;
    secret = restored.secret;
  });

  it('F12-T02: reading the integration never returns a secret, in any form', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/admin/companies/${COMPANY_A.id}/webhook-integration`)
      .set(asUser(adminCookie))
      .expect(200);

    const serialised = JSON.stringify(response.body);

    expect(response.body.configured).toBe(true);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('whsec_');
    // Not even the ciphertext, the IV or the tag.
    expect(serialised).not.toContain('secretCiphertext');
    expect(serialised).not.toContain('secretIv');
    expect(serialised).not.toContain('secretAuthTag');
  });

  it('F12-T03: the signing secret is not stored in plaintext', async () => {
    const row = await prisma.webhookIntegration.findUniqueOrThrow({
      where: { companyId: COMPANY_A.id },
    });

    const stored = Buffer.from(row.secretCiphertext).toString('utf8');

    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('whsec_');
    expect(row.secretIv.length).toBe(12);
    expect(row.secretAuthTag.length).toBe(16);
  });

  it('F12-T04: a company manager cannot provision an integration', async () => {
    const managerCookie = await login(
      app,
      USERS.find((u) => u.companyId === COMPANY_A.id)!.email,
      USERS.find((u) => u.companyId === COMPANY_A.id)!.password,
    );

    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${COMPANY_A.id}/webhook-integration`)
      .set(asUser(managerCookie))
      .expect(403);
  });

  // ===========================================================================
  // Signature verification
  // ===========================================================================

  it('F12-T10: a correctly signed event is accepted', async () => {
    const response = await send(cardEvent()).expect(202);

    expect(response.body.status).toBe('ACCEPTED');
    expect(typeof response.body.eventId).toBe('string');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('F12-T11: a missing signature is refused', async () => {
    const response = await send(cardEvent(), { omit: ['signature'] }).expect(401);

    expect(response.body.error).toBe('webhook_signature_invalid');
  });

  it('F12-T12: a missing webhook id is refused', async () => {
    await send(cardEvent(), { omit: ['id'] }).expect(401);
  });

  it('F12-T13: a missing timestamp is refused', async () => {
    await send(cardEvent(), { omit: ['timestamp'] }).expect(401);
  });

  it('F12-T14: a wrong signature is refused', async () => {
    await send(cardEvent(), { signature: 'f'.repeat(64) }).expect(401);
  });

  it('F12-T15: a signature of the wrong LENGTH is refused', async () => {
    // Shape is checked before the comparison, because `timingSafeEqual`
    // throws on a length mismatch - and that throw would itself be a length
    // oracle.
    await send(cardEvent(), { signature: 'ab'.repeat(16) }).expect(401);
    await send(cardEvent(), { signature: 'ab'.repeat(64) }).expect(401);
  });

  it('F12-T16: a signature in the wrong ENCODING is refused', async () => {
    const event = cardEvent();
    const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const hex = sign(secret, timestamp, rawBody);

    // The same MAC, base64 instead of hex, and uppercase hex. Both are
    // "correct" signatures in the wrong alphabet, and both must fail.
    await send(event, {
      timestamp,
      signature: Buffer.from(hex, 'hex').toString('base64'),
    }).expect(401);

    await send(event, { timestamp, signature: hex.toUpperCase() }).expect(401);
  });

  it('F12-T17: a signature computed with ANOTHER company’s secret is refused', async () => {
    const event = cardEvent();
    const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1_000));

    // Company A's delivery id, company B's secret. Knowing a delivery id is
    // not authority - it only selects which secret to check against.
    await send(event, { timestamp, signature: sign(otherSecret, timestamp, rawBody) }).expect(
      401,
    );
  });

  it('F12-T18: a modified body is refused, even with a signature that was valid', async () => {
    const event = cardEvent({ amount: 10_000 });
    const tampered = cardEvent({ ...(event.data as object), amount: 1 });

    await send(event, {
      bodyOverride: JSON.stringify(tampered),
    }).expect(401);
  });

  it('F12-T19: re-serialised JSON with different whitespace is refused', async () => {
    // THE case for verifying raw bytes. The object is identical; only the
    // formatting differs. A verifier that parsed and re-serialised would
    // accept this - and would therefore also accept a body it had not
    // actually authenticated.
    const event = cardEvent();

    await send(event, {
      bodyOverride: JSON.stringify(event, null, 2),
    }).expect(401);
  });

  it('F12-T20: an expired signature timestamp is refused', async () => {
    const stale = String(Math.floor(Date.now() / 1_000) - 3_600);

    // Correctly signed FOR that timestamp - the MAC and the bytes agree. It
    // is refused because it is old, which is the whole of replay protection.
    await send(cardEvent(), { timestamp: stale }).expect(401);
  });

  it('F12-T21: an excessively future-dated timestamp is refused', async () => {
    const ahead = String(Math.floor(Date.now() / 1_000) + 3_600);

    // Without a future bound, a captured request signed years ahead stays
    // replayable until that date arrives.
    await send(cardEvent(), { timestamp: ahead }).expect(401);
  });

  it('F12-T22: a timestamp just inside the tolerance is accepted', async () => {
    const edge = String(Math.floor(Date.now() / 1_000) - 290);

    await send(cardEvent(), { timestamp: edge }).expect(202);
  });

  it('F12-T23: a non-numeric timestamp is refused', async () => {
    // `parseInt` would accept `1763000000abc`. `Number`, behind a regex,
    // does not.
    await send(cardEvent(), { headerTimestamp: '1763000000abc' }).expect(401);
    await send(cardEvent(), { headerTimestamp: 'not-a-timestamp' }).expect(401);
  });

  it('F12-T24: an unknown delivery id is refused', async () => {
    await send(cardEvent(), { deliveryId: 'whi_does-not-exist' }).expect(401);
  });

  it('F12-T25: a refused delivery stores NOTHING', async () => {
    const event = cardEvent({ id: 'evt_never_stored', transactionId: 'txn_never_stored' });

    await send(event, { signature: 'f'.repeat(64) }).expect(401);
    await send(event, { timestamp: String(Math.floor(Date.now() / 1_000) - 3_600) }).expect(401);
    await send(event, { deliveryId: 'whi_nope' }).expect(401);

    expect(await prisma.webhookEvent.count({ where: { providerEventId: 'evt_never_stored' } })).toBe(
      0,
    );
    expect(await prisma.expense.count({ where: { externalId: 'txn_never_stored' } })).toBe(0);
  });

  it('F12-T26: the route is reachable without a session or the CSRF header', async () => {
    // A payment provider has no cookie and no reason to send `x-limaz-client`.
    // The route is @Public() and @WebhookExempt(), and authenticates on the
    // signature instead - so a correctly signed request with neither must
    // succeed, and an unsigned one must not.
    await send(cardEvent()).expect(202);

    await request(app.getHttpServer()).post(WEBHOOK_PATH).send({}).expect(401);
  });

  // ===========================================================================
  // Request validation, after authentication
  // ===========================================================================

  it('F12-T30: a body that is not JSON is a 400, not a 500', async () => {
    const rawBody = Buffer.from('{not json', 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1_000));

    const response = await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .set('x-limaz-webhook-id', deliveryId)
      .set('x-limaz-timestamp', timestamp)
      .set('x-limaz-signature', sign(secret, timestamp, rawBody))
      // A STRING, so supertest sends the exact bytes that were signed.
      .send(rawBody.toString('utf8'));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('F12-T31: a missing envelope field is a 400', async () => {
    const response = await send({ type: 'transaction.settled', data: {} }).expect(400);

    expect(response.body.message).toContain('id');
  });

  it('F12-T32: a malformed payload field is a 400 naming it', async () => {
    const event = cardEvent();
    (event.data as Record<string, unknown>).amount = 12.5;

    const response = await send(event).expect(400);

    expect(response.body.message).toContain('data.amount');
  });

  it('F12-T33: an unknown field INSIDE data is refused', async () => {
    const event = cardEvent();
    (event.data as Record<string, unknown>).cardNumber = '4111111111111111';

    await send(event).expect(400);
  });

  it('F12-T34: an unknown field on the ENVELOPE is tolerated', async () => {
    // The one deliberate exception to this codebase's strict-parse rule. A
    // webhook contract belongs to the provider and providers add fields; the
    // company is decided by the signature, so an unread property cannot
    // influence anything.
    const event = { ...cardEvent(), livemode: false, apiVersion: '2026-01-01' };

    await send(event).expect(202);
  });

  it('F12-T35: an unsupported event type is ACCEPTED and ignored, not refused', async () => {
    // The provider retries until it gets a 2xx. Refusing an event type we do
    // not handle would be an infinite retry loop.
    const event = cardEvent({ id: 'evt_unsupported_1', type: 'transaction.reversed' });

    const response = await send(event).expect(202);

    expect(response.body.status).toBe('IGNORED');

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { providerEventId: 'evt_unsupported_1' },
    });

    expect(stored.status).toBe('IGNORED');
    expect(stored.expenseId).toBeNull();
    expect(stored.lastError).toContain('transaction.reversed');
  });

  it('F12-T36: an unsupported type with a shape we could not parse is still accepted', async () => {
    // Its `data` is nothing like a settled transaction. Validating the
    // payload before checking the type would refuse it.
    const event = {
      id: 'evt_unsupported_2',
      type: 'card.issued',
      createdAt: new Date().toISOString(),
      data: { cardId: 'card_1', last4: '4242' },
    };

    const response = await send(event).expect(202);

    expect(response.body.status).toBe('IGNORED');
  });

  // ===========================================================================
  // Tenancy
  // ===========================================================================

  it('F12-T40: the event is bound to the company whose secret verified it', async () => {
    const event = cardEvent({ id: 'evt_tenant_1' });

    await send(event).expect(202);

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { providerEventId: 'evt_tenant_1' },
    });

    expect(stored.companyId).toBe(COMPANY_A.id);
  });

  it('F12-T41: the body cannot name a company', async () => {
    // There is no company field in the schema, and `data` is strict - so the
    // attempt is a 400 rather than a value that is parsed and ignored.
    const event = cardEvent();
    (event.data as Record<string, unknown>).companyId = COMPANY_B.id;

    await send(event).expect(400);

    const envelopeAttempt = { ...cardEvent({ id: 'evt_tenant_2' }), companyId: COMPANY_B.id };

    // On the ENVELOPE it is tolerated and ignored - and the event still lands
    // in company A, because the company comes from the signature.
    await send(envelopeAttempt).expect(202);

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { providerEventId: 'evt_tenant_2' },
    });

    expect(stored.companyId).toBe(COMPANY_A.id);
  });

  it('F12-T42: two companies may use the same provider event id independently', async () => {
    const shared = 'evt_shared_id';

    await deliver(app, deliveryId, secret, cardEvent({ id: shared })).expect(202);
    await deliver(app, otherDeliveryId, otherSecret, cardEvent({ id: shared })).expect(202);

    const rows = await prisma.webhookEvent.findMany({ where: { providerEventId: shared } });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.companyId))).toEqual(
      new Set([COMPANY_A.id, COMPANY_B.id]),
    );
  });

  // ===========================================================================
  // Delivery deduplication
  // ===========================================================================

  it('F12-T50: the same event delivered twice creates one row', async () => {
    const event = cardEvent({ id: 'evt_dupe_1' });

    const first = await send(event).expect(202);
    const second = await send(event).expect(202);

    expect(first.body.status).toBe('ACCEPTED');
    expect(second.body.status).toBe('DUPLICATE');
    expect(second.body.eventId).toBe(first.body.eventId);

    expect(await prisma.webhookEvent.count({ where: { providerEventId: 'evt_dupe_1' } })).toBe(1);
  });

  it('F12-T51: a redelivery signed afresh is still a duplicate', async () => {
    // The identity of an event is its business payload, NOT its delivery
    // metadata. A provider replaying after an outage signs again, so the
    // timestamp and the signature differ while the payment has not changed.
    const event = cardEvent({ id: 'evt_dupe_2' });

    await send(event).expect(202);

    const later = String(Math.floor(Date.now() / 1_000) - 5);
    const response = await send(event, { timestamp: later }).expect(202);

    expect(response.body.status).toBe('DUPLICATE');
    expect(await prisma.webhookEvent.count({ where: { providerEventId: 'evt_dupe_2' } })).toBe(1);
  });

  it('F12-T52: two simultaneous deliveries of one event create one row', async () => {
    const event = cardEvent({ id: 'evt_race_1' });

    const [a, b] = await Promise.all([send(event), send(event)]);

    expect([a.status, b.status]).toEqual([202, 202]);

    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(['ACCEPTED', 'DUPLICATE']);

    // The UNIQUE constraint is the authority. A check-then-insert would let
    // both pass the check.
    expect(await prisma.webhookEvent.count({ where: { providerEventId: 'evt_race_1' } })).toBe(1);
  });

  it('F12-T53: the same event id with a DIFFERENT payment is refused', async () => {
    const id = 'evt_conflict_1';

    await send(cardEvent({ id, transactionId: 'txn_conflict_a', amount: 5_000 })).expect(202);

    const response = await send(
      cardEvent({ id, transactionId: 'txn_conflict_b', amount: 9_000 }),
    ).expect(409);

    expect(response.body.error).toBe('event_payload_conflict');
    expect(await prisma.webhookEvent.count({ where: { providerEventId: id } })).toBe(1);
  });

  it('F12-T54: acceptance does not create an expense', async () => {
    // The worker is off in this harness. A 202 therefore proves only that the
    // event is committed - which is exactly what it claims.
    const event = cardEvent({ id: 'evt_async_1', transactionId: 'txn_async_1' });

    await send(event).expect(202);

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { providerEventId: 'evt_async_1' },
    });

    expect(stored.status).toBe('PENDING');
    expect(stored.expenseId).toBeNull();
    expect(stored.attempts).toBe(0);
    expect(await prisma.expense.count({ where: { externalId: 'txn_async_1' } })).toBe(0);
  });

  it('F12-T55: a large body is refused by the existing size limit, not by us', async () => {
    const event = cardEvent();
    (event.data as Record<string, unknown>).merchant = 'x'.repeat(400_000);

    const response = await send(event);

    // 413 from the body parser. Before F12 this was a 500 on every endpoint
    // in the application - a parser rejection carrying a perfectly good 4xx
    // was being flattened by the filter's catch-all (AI_LOG 58).
    expect(response.status).toBe(413);
    expect(response.body.error).toBe('payload_too_large');
    expect(response.body.message).not.toContain('limit');
  });
});
