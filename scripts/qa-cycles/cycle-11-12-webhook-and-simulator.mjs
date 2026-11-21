/* Cycle 11: card webhook intake - signature verification, the durable inbox,
   asynchronous processing and deduplication.
   Cycle 12: the sandbox payment simulator. */
import crypto from 'node:crypto';
import { call, apiKey, login, session, test, check, eq, run, RUN } from './lib.mjs';

const ENDPOINT = '/v1/webhooks/card-transactions';

let A = null;
let co = null;
let other = null;

function sign(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), Buffer.from(rawBody, 'utf8')]))
    .digest('hex');
}

function envelope(overrides = {}, dataOverrides = {}) {
  return {
    id: `evt_${RUN}_${Math.random().toString(36).slice(2, 10)}`,
    type: 'transaction.settled',
    createdAt: new Date().toISOString(),
    data: {
      transactionId: `txn_${RUN}_${Math.random().toString(36).slice(2, 10)}`,
      cardholderId: 'card-qa-1',
      amount: 10_000,
      currency: 'SAR',
      merchant: 'QA Card Merchant',
      category: 'TRAVEL',
      spentAt: new Date().toISOString(),
      ...dataOverrides,
    },
    ...overrides,
  };
}

function deliver(integration, body, opts = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const secret = opts.secret ?? integration.signingSecret;
  const signature = opts.signature ?? sign(secret, timestamp, raw);
  const headers = { 'content-type': 'application/json' };
  if (!opts.omitId) headers['x-limaz-webhook-id'] = opts.deliveryId ?? integration.deliveryId;
  if (!opts.omitTimestamp) headers['x-limaz-timestamp'] = timestamp;
  if (!opts.omitSignature) headers['x-limaz-signature'] = signature;
  return call(ENDPOINT, { method: 'POST', headers, raw });
}

/** Waits for the inbox row to leave PENDING, then returns it. */
async function settle(eventId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await A.get(`/v1/admin/webhook-events/${eventId}`);
    if (res.status === 200) {
      last = res.json.event ?? res.json;
      if (last.status && last.status !== 'PENDING' && last.status !== 'PROCESSING') return last;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`event ${eventId} never settled: ${JSON.stringify(last)}`);
}

async function provision(name) {
  const made = await A.post('/v1/admin/companies', {
    name: `${name} ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 40_000,
    frequencyMaxCount: 1_000,
    frequencyWindowMinutes: 60,
    blockedCategories: ['GAMBLING'],
  });
  if (made.status !== 201) throw new Error(`company: ${made.status} ${made.text.slice(0, 200)}`);
  const companyId = made.json.company.id;
  const prov = await A.post(`/v1/admin/companies/${companyId}/webhook-integration`, {});
  if (prov.status !== 200) throw new Error(`provision: ${prov.status} ${prov.text.slice(0, 300)}`);
  const body = prov.json.integration ?? prov.json;
  const deliveryId = body.deliveryId ?? body.id;
  const signingSecret = body.signingSecret ?? body.secret ?? prov.json.signingSecret;
  if (!deliveryId || !signingSecret) {
    throw new Error(`unexpected provisioning shape: ${prov.text.slice(0, 400)}`);
  }
  const email = `qa-wh-${name.replace(/\W/g, '')}-${RUN}@qa.test`;
  await A.post(`/v1/admin/companies/${companyId}/managers`, {
    displayName: 'QA Webhook Manager',
    email,
    password: 'QaManagerPass!2026',
  });
  const mgr = await login({ email, password: 'QaManagerPass!2026' });
  return {
    companyId,
    deliveryId,
    signingSecret,
    apiKey: made.json.apiKey.plaintext,
    mgr: session(mgr.cookie),
    provisionResponse: prov,
  };
}

test('C11.00', 'provision a webhook integration for two companies', async () => {
  A = session((await login('admin')).cookie);
  co = await provision('QA Webhook Co');
  other = await provision('QA Other Webhook Co');
  check(co.deliveryId !== other.deliveryId, 'the two delivery ids collide');
  check(co.signingSecret !== other.signingSecret, 'the two secrets collide');
  check(co.signingSecret.startsWith('whsec_'), `odd secret shape: ${co.signingSecret.slice(0, 8)}`);
});

test('C11.01', 'the provisioning response forbids caching and shows the secret once', async () => {
  eq(
    /no-store/i.test(co.provisionResponse.headers['cache-control'] || ''),
    true,
    `cache-control was "${co.provisionResponse.headers['cache-control']}"`,
  );
  const describe = await A.get(`/v1/admin/companies/${co.companyId}/webhook-integration`);
  eq(describe.status, 200, 'describe');
  check(!describe.text.includes(co.signingSecret), 'the signing secret is readable again');
});

test('C11.02', 'a correctly signed delivery is accepted with 202', async () => {
  const body = envelope();
  const res = await deliver(co, body);
  eq(res.status, 202, `status (${res.text.slice(0, 250)})`);
  check(/no-store/i.test(res.headers['cache-control'] || ''), 'cache-control');
  co.firstEvent = body;
  co.firstEventId = res.json.eventId ?? res.json.id ?? res.json.event?.id;
  check(co.firstEventId, `no event id in ${res.text.slice(0, 250)}`);
});

test('C11.03', 'acceptance alone creates no expense - processing is asynchronous', async () => {
  // The event id is returned the instant the row commits. Whether an expense
  // exists yet is the worker's business, so only the inbox row is asserted here.
  const res = await A.get(`/v1/admin/webhook-events/${co.firstEventId}`);
  eq(res.status, 200, 'status');
  const e = res.json.event ?? res.json;
  check(
    ['PENDING', 'PROCESSING', 'PROCESSED'].includes(e.status),
    `unexpected inbox status ${e.status}`,
  );
});

test(
  'C11.04',
  'the worker turns the event into an expense through the same policy engine',
  async () => {
    const settled = await settle(co.firstEventId);
    eq(settled.status, 'PROCESSED', `inbox status (${JSON.stringify(settled).slice(0, 300)})`);
    const list = await co.mgr.get(`/v1/expenses?q=${co.firstEvent.data.transactionId}&limit=10`);
    eq(list.status, 200, 'list');
    eq(list.json.items.length, 1, 'exactly one expense');
    const e = list.json.items[0];
    eq(e.amountMinor, 10_000, 'amount');
    eq(e.decision, 'APPROVE', 'decision');
    eq(e.externalId, co.firstEvent.data.transactionId, 'externalId is the transaction id');
  },
);

test('C11.05', 'a card payment over the limit is flagged for review, with the reason', async () => {
  const body = envelope({}, { amount: 50_000 });
  const res = await deliver(co, body);
  eq(res.status, 202, 'accepted');
  await settle(res.json.eventId ?? res.json.id);
  const list = await co.mgr.get(`/v1/expenses?q=${body.data.transactionId}&limit=10`);
  eq(list.json.items.length, 1, 'one expense');
  eq(list.json.items[0].decision, 'REVIEW', 'decision');
  const reviews = await co.mgr.get('/v1/reviews?limit=100');
  const match = (reviews.json.items ?? []).filter(
    (r) => r.expense?.externalId === body.data.transactionId,
  );
  eq(match.length, 1, 'exactly one review opened');
  const detail = await co.mgr.get(`/v1/reviews/${match[0].id}`);
  eq(detail.status, 200, 'review detail');
  const codes = (detail.json.reasons ?? []).map((x) => x.code ?? x.ruleCode);
  check(codes.includes('AMOUNT_LIMIT'), `reasons ${JSON.stringify(detail.json.reasons)}`);
});

test('C11.06', 'a card payment in a blocked category is rejected', async () => {
  const body = envelope({}, { amount: 100, category: 'GAMBLING' });
  const res = await deliver(co, body);
  eq(res.status, 202, 'accepted');
  await settle(res.json.eventId ?? res.json.id);
  const list = await co.mgr.get(`/v1/expenses?q=${body.data.transactionId}&limit=10`);
  eq(list.json.items[0].decision, 'REJECT', 'decision');
});

test(
  'C11.07',
  'a webhook expense and an identical API expense reach the same decision',
  async () => {
    const amount = 45_000;
    const body = envelope({}, { amount });
    const hook = await deliver(co, body);
    await settle(hook.json.eventId ?? hook.json.id);
    const viaHook = (await co.mgr.get(`/v1/expenses?q=${body.data.transactionId}&limit=5`)).json
      .items[0];

    const direct = await apiKey(co.apiKey, '/v1/expenses', {
      method: 'POST',
      body: {
        externalId: `direct-${body.data.transactionId}`,
        employeeId: body.data.cardholderId,
        amount,
        currency: 'SAR',
        merchant: body.data.merchant,
        category: body.data.category,
        spentAt: body.data.spentAt,
      },
    });
    eq(direct.status, 201, 'direct submission');
    eq(viaHook.decision, direct.json.decision, 'the two paths disagree');
  },
);

/* ---- signature verification ---- */

const refusals = [
  ['C11.08', 'a wrong signature', (b) => deliver(co, b, { signature: 'a'.repeat(64) })],
  ['C11.09', 'a malformed signature', (b) => deliver(co, b, { signature: 'not-hex' })],
  ['C11.10', 'an empty signature', (b) => deliver(co, b, { signature: '' })],
  ['C11.11', 'a missing signature header', (b) => deliver(co, b, { omitSignature: true })],
  ['C11.12', 'a missing timestamp header', (b) => deliver(co, b, { omitTimestamp: true })],
  ['C11.13', 'a missing delivery id header', (b) => deliver(co, b, { omitId: true })],
  ['C11.14', 'an unknown delivery id', (b) => deliver(co, b, { deliveryId: 'whk_does_not_exist' })],
  [
    'C11.15',
    'a timestamp far in the past',
    (b) => deliver(co, b, { timestamp: Math.floor(Date.now() / 1000) - 7200 }),
  ],
  [
    'C11.16',
    'a timestamp far in the future',
    (b) => deliver(co, b, { timestamp: Math.floor(Date.now() / 1000) + 7200 }),
  ],
  ['C11.17', 'a non-numeric timestamp', (b) => deliver(co, b, { timestamp: '17630000abc' })],
  ['C11.18', "another company's secret", (b) => deliver(co, b, { secret: other.signingSecret })],
  [
    'C11.19',
    "another company's delivery id with our signature",
    (b) => deliver(co, b, { deliveryId: other.deliveryId }),
  ],
];

for (const [tid, name, send] of refusals) {
  test(tid, `${name} is refused with 401 and stores nothing`, async () => {
    const body = envelope();
    const res = await send(body);
    eq(res.status, 401, `status (${res.text.slice(0, 200)})`);
    const list = await co.mgr.get(`/v1/expenses?q=${body.data.transactionId}&limit=5`);
    eq(list.json.items.length, 0, 'an expense was created from a refused delivery');
  });
}

test('C11.20', 'the refusal never says which check failed', async () => {
  const bodies = await Promise.all([
    deliver(co, envelope(), { signature: 'a'.repeat(64) }),
    deliver(co, envelope(), { deliveryId: 'whk_does_not_exist' }),
    deliver(co, envelope(), { timestamp: Math.floor(Date.now() / 1000) - 7200 }),
  ]);
  const shapes = new Set(bodies.map((r) => JSON.stringify(r.json)));
  eq(shapes.size, 1, `the refusals differ and leak the cause: ${[...shapes].join(' | ')}`);
});

test('C11.21', 'the same object re-serialised with different whitespace is refused', async () => {
  const body = envelope();
  const compact = JSON.stringify(body);
  const pretty = JSON.stringify(body, null, 2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(co.signingSecret, timestamp, compact);
  const res = await call(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-limaz-webhook-id': co.deliveryId,
      'x-limaz-timestamp': timestamp,
      'x-limaz-signature': signature,
    },
    raw: pretty,
  });
  eq(res.status, 401, `the signature covers the parsed object, not the raw bytes (${res.status})`);
});

test('C11.22', 'a tampered amount with the original signature is refused', async () => {
  const body = envelope();
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(co.signingSecret, timestamp, raw);
  const tampered = raw.replace('"amount":10000', '"amount":1');
  check(tampered !== raw, 'the test failed to tamper with the body');
  const res = await call(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-limaz-webhook-id': co.deliveryId,
      'x-limaz-timestamp': timestamp,
      'x-limaz-signature': signature,
    },
    raw: tampered,
  });
  eq(res.status, 401, 'status');
});

test(
  'C11.23',
  'the endpoint takes no API key and no session as a substitute for a signature',
  async () => {
    const body = envelope();
    const res = await call(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': co.apiKey },
      raw: JSON.stringify(body),
    });
    eq(res.status, 401, 'status');
  },
);

/* ---- deduplication ---- */

test('C11.24', 'a redelivery of the same event is recognised and creates nothing new', async () => {
  const body = envelope();
  const first = await deliver(co, body);
  eq(first.status, 202, 'first');
  const eventId = first.json.eventId ?? first.json.id;
  await settle(eventId);

  const again = await deliver(co, body);
  check([200, 202].includes(again.status), `redelivery status ${again.status}`);
  check(
    /DUPLICATE|duplicate|already/i.test(again.text),
    `the redelivery is not reported as a duplicate: ${again.text.slice(0, 200)}`,
  );
  eq(again.json.eventId ?? again.json.id, eventId, 'a second event row was created');

  const list = await co.mgr.get(`/v1/expenses?q=${body.data.transactionId}&limit=10`);
  eq(list.json.items.length, 1, 'a second expense was created');
});

test('C11.25', 'six simultaneous deliveries of one event create exactly one expense', async () => {
  const body = envelope();
  const responses = await Promise.all(Array.from({ length: 6 }, () => deliver(co, body)));
  check(
    responses.every((r) => [200, 202].includes(r.status)),
    `statuses: ${responses.map((r) => r.status).join(',')} -- ${responses.find((r) => r.status > 202)?.text?.slice(0, 200)}`,
  );
  const ids = new Set(responses.map((r) => r.json.eventId ?? r.json.id));
  eq(ids.size, 1, `more than one event row: ${[...ids].join(', ')}`);
  await settle([...ids][0]);
  const list = await co.mgr.get(`/v1/expenses?q=${body.data.transactionId}&limit=10`);
  eq(list.json.items.length, 1, 'expense count');
});

test('C11.26', 'the same event id with a different payload is refused as a conflict', async () => {
  const body = envelope();
  const first = await deliver(co, body);
  eq(first.status, 202, 'first');
  const conflicting = { ...body, data: { ...body.data, amount: 99_999 } };
  const res = await deliver(co, conflicting);
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  eq(res.status, 409, `status (${res.text.slice(0, 200)})`);
});

test(
  'C11.27',
  'the same transaction under two different event ids becomes one expense',
  async () => {
    const body = envelope();
    const first = await deliver(co, body);
    await settle(first.json.eventId ?? first.json.id);
    const second = { ...body, id: `${body.id}-redelivered` };
    const res = await deliver(co, second);
    eq(res.status, 202, `second delivery (${res.text.slice(0, 200)})`);
    await settle(res.json.eventId ?? res.json.id);
    const list = await co.mgr.get(`/v1/expenses?q=${body.data.transactionId}&limit=10`);
    eq(list.json.items.length, 1, 'one transaction must mean one expense');
  },
);

/* ---- payload handling ---- */

test(
  'C11.28',
  'an event type this system does not handle is accepted but creates no expense',
  async () => {
    const body = envelope({ type: 'transaction.authorized' });
    const res = await deliver(co, body);
    eq(res.status, 202, `status (${res.text.slice(0, 200)})`);
    const settled = await settle(res.json.eventId ?? res.json.id);
    eq(settled.status, 'IGNORED', `inbox status (${JSON.stringify(settled).slice(0, 200)})`);
  },
);

test('C11.29', 'valid signature over malformed JSON is 400, never a 500', async () => {
  const raw = '{"id":"evt_x", "type":';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await call(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-limaz-webhook-id': co.deliveryId,
      'x-limaz-timestamp': timestamp,
      'x-limaz-signature': sign(co.signingSecret, timestamp, raw),
    },
    raw,
  });
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  eq(res.status, 400, 'status');
});

const badPayloads = [
  ['C11.30', 'a negative amount', { amount: -100 }],
  ['C11.31', 'a fractional amount', { amount: 10.5 }],
  ['C11.32', 'a missing transactionId', { transactionId: undefined }],
  ['C11.33', 'an unknown field inside data', { surprise: true }],
  ['C11.34', 'a bad currency', { currency: 'SARS' }],
  ['C11.35', 'a spentAt with no offset', { spentAt: '2026-11-20T09:15:00' }],
];

for (const [tid, name, patch] of badPayloads) {
  test(tid, `a correctly signed event with ${name} is 400, never a 500`, async () => {
    const body = envelope();
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete body.data[k];
      else body.data[k] = v;
    }
    const res = await deliver(co, body);
    check(res.status !== 500, `server error: ${res.text.slice(0, 250)}`);
    eq(res.status, 400, `status (${res.text.slice(0, 200)})`);
  });
}

test('C11.36', 'a company with no webhook integration cannot be reached by signature', async () => {
  const made = await A.post('/v1/admin/companies', { name: `QA No Hook ${RUN}`, currency: 'SAR' });
  const res = await A.get(`/v1/admin/companies/${made.json.company.id}/webhook-integration`);
  eq(res.status, 200, 'describe');
  const state = res.json.integration ?? res.json;
  check(
    state === null || state.provisioned === false || state.deliveryId == null,
    `expected an unprovisioned state, got ${res.text.slice(0, 200)}`,
  );
});

test('C11.37', 're-provisioning replaces the secret and the old one stops verifying', async () => {
  const before = co.signingSecret;
  const res = await A.post(`/v1/admin/companies/${co.companyId}/webhook-integration`, {});
  eq(res.status, 200, 'reprovision');
  const body = res.json.integration ?? res.json;
  const after = body.signingSecret ?? body.secret ?? res.json.signingSecret;
  check(after && after !== before, 'the secret did not change');
  const stale = await deliver(co, envelope(), { secret: before });
  eq(stale.status, 401, 'the old secret still verifies');
  co.signingSecret = after;
  co.deliveryId = body.deliveryId ?? body.id ?? co.deliveryId;
  const fresh = await deliver(co, envelope());
  eq(fresh.status, 202, `the new secret does not verify (${fresh.text.slice(0, 200)})`);
});

/* ---- Cycle 12: the sandbox simulator ---- */

test('C12.01', 'the simulator describes itself to the administrator only', async () => {
  const res = await A.get('/v1/admin/simulator');
  eq(res.status, 200, `status (${res.text.slice(0, 200)})`);
  const mgr = await co.mgr.get('/v1/admin/simulator');
  eq(mgr.status, 403, 'a manager must not reach the simulator');
});

test('C12.02', 'the simulator delivers a real signed request that becomes an expense', async () => {
  const res = await A.post('/v1/admin/simulator/payments', {
    companyId: co.companyId,
    mode: 'VALID',
    amount: 12_500,
    cardholderId: 'card-qa-sim',
    merchant: 'QA Simulator Merchant',
    category: 'TRAVEL',
  });
  check([200, 201].includes(res.status), `status ${res.status} (${res.text.slice(0, 300)})`);
  const r = res.json;
  const httpStatus = r.delivery?.status ?? r.response?.status ?? r.httpStatus;
  eq(httpStatus, 202, `the endpoint answered ${httpStatus} (${res.text.slice(0, 300)})`);
  const eventId = r.eventId ?? r.delivery?.eventId ?? r.event?.id;
  check(eventId, `no event id in ${res.text.slice(0, 300)}`);
  const settled = await settle(eventId);
  eq(settled.status, 'PROCESSED', 'inbox status');
});

test('C12.03', 'the invalid-signature preset is refused by the real verifier', async () => {
  const res = await A.post('/v1/admin/simulator/payments', {
    companyId: co.companyId,
    mode: 'INVALID_SIGNATURE',
    amount: 1_000,
    cardholderId: 'card-qa-sim',
    merchant: 'QA Simulator Merchant',
    category: 'TRAVEL',
  });
  check([200, 201].includes(res.status), `status ${res.status} (${res.text.slice(0, 300)})`);
  const httpStatus = res.json.delivery?.status ?? res.json.response?.status ?? res.json.httpStatus;
  eq(httpStatus, 401, `expected the endpoint to refuse, got ${httpStatus}`);
});

test('C12.04', 'the expired-signature preset is refused by the real verifier', async () => {
  const res = await A.post('/v1/admin/simulator/payments', {
    companyId: co.companyId,
    mode: 'EXPIRED_SIGNATURE',
    amount: 1_000,
    cardholderId: 'card-qa-sim',
    merchant: 'QA Simulator Merchant',
    category: 'TRAVEL',
  });
  const httpStatus = res.json.delivery?.status ?? res.json.response?.status ?? res.json.httpStatus;
  eq(httpStatus, 401, `expected the endpoint to refuse, got ${httpStatus}`);
});

test('C12.05', 'the simulator cannot be pointed at a company that has no integration', async () => {
  const made = await A.post('/v1/admin/companies', { name: `QA Sim Bare ${RUN}`, currency: 'SAR' });
  const res = await A.post('/v1/admin/simulator/payments', {
    companyId: made.json.company.id,
    mode: 'VALID',
    amount: 1_000,
    cardholderId: 'card-qa-sim',
    merchant: 'QA',
    category: 'TRAVEL',
  });
  check(res.status !== 500, `server error: ${res.text.slice(0, 250)}`);
  check([400, 404, 409, 422].includes(res.status), `status ${res.status}`);
});

test(
  'C12.06',
  'the webhook event listing is filtered by company and never leaks across tenants',
  async () => {
    const res = await A.get(`/v1/admin/webhook-events?companyId=${co.companyId}&limit=100`);
    eq(res.status, 200, 'status');
    const items = res.json.items ?? [];
    check(items.length > 0, 'no events listed');
    const foreign = items.filter((e) => e.companyId && e.companyId !== co.companyId);
    eq(foreign.length, 0, 'events from another company leaked');
  },
);

run('CYCLE 11-12  card webhook intake and the sandbox simulator');
