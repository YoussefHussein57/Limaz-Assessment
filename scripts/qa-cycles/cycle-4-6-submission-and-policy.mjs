/* Cycle 4: submission input validation (never a 500).
   Cycle 5: idempotency and concurrency.
   Cycle 6: the policy engine, on a company created for this run. */
import {
  call,
  apiKey,
  login,
  session,
  expense,
  test,
  check,
  eq,
  run,
  RUN,
  NILE_KEY,
} from './lib.mjs';

const submit = (body, key = NILE_KEY) => apiKey(key, '/v1/expenses', { method: 'POST', body });

const id = (res) => res.json?.expenseId ?? res.json?.id ?? res.json?.expense?.id;

/* ---------------- Cycle 4: input validation ---------------- */

const badBodies = [
  ['C4.01', 'amount as a decimal', { amount: 125.5 }],
  ['C4.02', 'amount zero', { amount: 0 }],
  ['C4.03', 'amount negative', { amount: -100 }],
  ['C4.04', 'amount above int4', { amount: 2_147_483_648 }],
  ['C4.05', 'amount as a string', { amount: '100' }],
  ['C4.06', 'amount as null', { amount: null }],
  ['C4.07', 'currency lowercase four letters', { currency: 'sarr' }],
  ['C4.08', 'currency empty', { currency: '' }],
  ['C4.09', 'spentAt without an offset', { spentAt: '2026-11-20T09:15:00' }],
  ['C4.10', 'spentAt 30 February', { spentAt: '2026-02-30T09:15:00Z' }],
  ['C4.11', 'spentAt nonsense', { spentAt: 'yesterday' }],
  ['C4.12', 'externalId empty', { externalId: '' }],
  ['C4.13', 'externalId with surrounding whitespace', { externalId: '  pad  ' }],
  ['C4.14', 'externalId with a control character', { externalId: 'bad\u0000id' }],
  ['C4.15', 'externalId over 128 characters', { externalId: 'x'.repeat(129) }],
  ['C4.16', 'merchant only whitespace', { merchant: '   ' }],
  ['C4.17', 'merchant over 200 characters', { merchant: 'm'.repeat(201) }],
  ['C4.18', 'category only whitespace', { category: '  ' }],
  ['C4.19', 'category over 64 characters', { category: 'c'.repeat(65) }],
  ['C4.20', 'an unexpected extra field', { surprise: true }],
  ['C4.21', 'employeeId as a number', { employeeId: 42 }],
  ['C4.22', 'a nested object where a string belongs', { merchant: { name: 'x' } }],
  ['C4.23', 'an array where a string belongs', { category: ['TRAVEL'] }],
];

for (const [tid, name, patch] of badBodies) {
  test(tid, `400 for ${name}, never a 500`, async () => {
    const res = await submit({ ...expense(), ...patch });
    check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
    eq(res.status, 400, `status (body: ${res.text.slice(0, 160)})`);
    check(res.json && res.json.message, 'no explanatory message');
  });
}

test('C4.24', '400 for a missing required field', async () => {
  const body = expense();
  delete body.merchant;
  const res = await submit(body);
  eq(res.status, 400, 'status');
});

test('C4.25', '400 for a malformed JSON body, never a 500', async () => {
  const res = await call('/v1/expenses', {
    method: 'POST',
    headers: { 'x-api-key': NILE_KEY, 'content-type': 'application/json' },
    raw: '{"externalId": "x", ',
  });
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  eq(res.status, 400, 'status');
});

test('C4.26', '400 for an empty body', async () => {
  const res = await call('/v1/expenses', {
    method: 'POST',
    headers: { 'x-api-key': NILE_KEY, 'content-type': 'application/json' },
    raw: '',
  });
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  eq(res.status, 400, 'status');
});

test('C4.27', 'no validation message ever echoes the API key', async () => {
  const res = await submit({ ...expense(), amount: -1 });
  check(!res.text.includes(NILE_KEY), 'the API key appeared in an error body');
});

test(
  'C4.28',
  'a wrong currency for the company is a business refusal, not a shape error',
  async () => {
    const res = await submit({ ...expense(), currency: 'USD' });
    check(res.status === 422 || res.status === 400, `expected 422/400, got ${res.status}`);
    check(res.status !== 500, 'server error');
  },
);

test('C4.29', 'a far-future spentAt is refused as a business rule', async () => {
  const far = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString();
  const res = await submit({ ...expense(), spentAt: far });
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  check(res.status === 422 || res.status === 400, `expected 422/400, got ${res.status}`);
});

test('C4.30', 'amount exactly at the int4 ceiling is accepted or cleanly refused', async () => {
  const res = await submit({ ...expense(), amount: 2_147_483_647 });
  check(res.status !== 500, `server error: ${res.text.slice(0, 300)}`);
  check([201, 422].includes(res.status), `unexpected status ${res.status}`);
});

/* ---------------- Cycle 5: idempotency ---------------- */

test(
  'C5.01',
  'a byte-identical retry returns the same decision and creates no second expense',
  async () => {
    const body = expense({ amount: 88800 });
    const first = await submit(body);
    eq(first.status, 201, 'first');
    const second = await submit(body);
    eq(second.status, 200, 'retry status');
    eq(second.json.duplicate, true, 'duplicate flag');
    eq(second.json.decision, first.json.decision, 'decision');
    eq(id(second), id(first), 'expense id');
  },
);

test('C5.02', 'a third identical retry is still the same expense', async () => {
  const body = expense();
  const a = await submit(body);
  await submit(body);
  const c = await submit(body);
  eq(c.status, 200, 'status');
  eq(id(c), id(a), 'expense id');
});

test('C5.03', 'the same externalId with a different body is 409', async () => {
  const body = expense({ amount: 1000 });
  const first = await submit(body);
  eq(first.status, 201, 'first');
  const conflict = await submit({ ...body, amount: 2000 });
  eq(conflict.status, 409, `status (body: ${conflict.text.slice(0, 200)})`);
});

test('C5.04', 'a 409 conflict does not alter the original expense', async () => {
  const body = expense({ amount: 1000 });
  const first = await submit(body);
  await submit({ ...body, amount: 999_99 });
  const nile = await login('nile');
  const read = await session(nile.cookie).get(`/v1/expenses/${id(first)}`);
  eq(read.status, 200, 'read');
  eq(read.json.amountMinor ?? read.json.amount, 1000, 'amount unchanged');
});

test('C5.05', 'eight simultaneous identical submissions create exactly one expense', async () => {
  const body = expense({ amount: 12345 });
  const responses = await Promise.all(Array.from({ length: 8 }, () => submit(body)));
  const codes = responses.map((r) => r.status).sort();
  check(
    responses.every((r) => r.status === 200 || r.status === 201),
    `unexpected statuses: ${codes.join(',')} -- ${responses.find((r) => r.status > 201)?.text?.slice(0, 200)}`,
  );
  const created = responses.filter((r) => r.status === 201);
  eq(created.length, 1, `exactly one 201 (got ${codes.join(',')})`);
  const ids = new Set(responses.map(id));
  eq(ids.size, 1, `all responses name one expense (got ${[...ids].join(', ')})`);
  const decisions = new Set(responses.map((r) => r.json.decision));
  eq(decisions.size, 1, 'all responses carry the same decision');
});

test('C5.06', 'a retry does not count twice towards the frequency rule', async () => {
  // Proven on a dedicated company in cycle 6; here, assert the row count.
  const body = expense();
  await submit(body);
  await submit(body);
  await submit(body);
  const nile = await login('nile');
  const list = await session(nile.cookie).get(`/v1/expenses?q=${body.externalId}&limit=50`);
  eq(list.status, 200, 'list');
  const items = list.json.items ?? [];
  eq(items.length, 1, `expected one row for ${body.externalId}, got ${items.length}`);
});

/* ---------------- Cycle 6: the policy engine ---------------- */

let co = null; // { companyId, apiKey, managerCookie }

test('C6.00', 'set up a company for this cycle with a known policy', async () => {
  const admin = await login('admin');
  const s = session(admin.cookie);
  const res = await s.post('/v1/admin/companies', {
    name: `QA Policy Co ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 50_000,
    frequencyMaxCount: 3,
    frequencyWindowMinutes: 60,
    blockedCategories: ['GAMBLING'],
  });
  eq(res.status, 201, `create company (body: ${res.text.slice(0, 300)})`);
  const companyId = res.json.company?.id ?? res.json.companyId ?? res.json.id;
  const key = res.json.apiKey?.plaintext;
  check(companyId, `no companyId in ${JSON.stringify(res.json).slice(0, 300)}`);
  check(typeof key === 'string', `no raw API key in ${JSON.stringify(res.json).slice(0, 300)}`);

  const mgr = await s.post(`/v1/admin/companies/${companyId}/managers`, {
    displayName: 'QA Manager',
    email: `qa-${RUN}@qa.test`,
    password: 'QaManagerPass!2026',
  });
  eq(mgr.status, 201, `create manager (body: ${mgr.text.slice(0, 300)})`);
  const mgrLogin = await login({ email: `qa-${RUN}@qa.test`, password: 'QaManagerPass!2026' });
  co = { companyId, key, cookie: mgrLogin.cookie, adminCookie: admin.cookie };
});

test('C6.01', 'an amount below the limit is APPROVE', async () => {
  const res = await submit(expense({ amount: 49_999 }), co.key);
  eq(res.status, 201, 'status');
  eq(res.json.decision, 'APPROVE', 'decision');
  eq(res.json.reasons.length, 0, 'no reasons');
});

test('C6.02', 'an amount exactly at the limit is APPROVE (the boundary is >, not >=)', async () => {
  const res = await submit(expense({ amount: 50_000 }), co.key);
  eq(res.json.decision, 'APPROVE', `decision (reasons: ${JSON.stringify(res.json.reasons)})`);
});

test('C6.03', 'one minor unit above the limit is REVIEW with AMOUNT_LIMIT', async () => {
  const res = await submit(expense({ amount: 50_001 }), co.key);
  eq(res.json.decision, 'REVIEW', 'decision');
  const codes = res.json.reasons.map((r) => r.ruleCode ?? r.code);
  check(codes.includes('AMOUNT_LIMIT'), `reasons: ${JSON.stringify(res.json.reasons)}`);
});

test('C6.04', 'AMOUNT_LIMIT carries the limit it was judged against', async () => {
  const res = await submit(expense({ amount: 60_000 }), co.key);
  const hit = res.json.reasons.find((r) => (r.ruleCode ?? r.code) === 'AMOUNT_LIMIT');
  check(hit, 'no AMOUNT_LIMIT reason');
  const detail = hit.detail ?? hit;
  eq(detail.autoApproveLimitMinor, 50_000, 'limit in the evidence');
  eq(detail.amountMinor, 60_000, 'amount in the evidence');
});

test('C6.05', 'a blocked category is REJECT', async () => {
  const res = await submit(expense({ amount: 100, category: 'GAMBLING' }), co.key);
  eq(res.json.decision, 'REJECT', 'decision');
});

test('C6.06', 'a blocked category matches regardless of case', async () => {
  const res = await submit(expense({ amount: 100, category: 'gambling' }), co.key);
  eq(
    res.json.decision,
    'REJECT',
    `decision for lowercase (reasons ${JSON.stringify(res.json.reasons)})`,
  );
});

test('C6.07', 'a blocked category matches with surrounding whitespace', async () => {
  const res = await submit(expense({ amount: 100, category: '  Gambling  ' }), co.key);
  eq(res.json.decision, 'REJECT', 'decision');
});

test('C6.08', 'REJECT beats REVIEW and both reasons are returned', async () => {
  const res = await submit(expense({ amount: 90_000, category: 'GAMBLING' }), co.key);
  eq(res.json.decision, 'REJECT', 'decision');
  const codes = res.json.reasons.map((r) => r.ruleCode ?? r.code).sort();
  check(
    codes.includes('AMOUNT_LIMIT') && codes.includes('BLOCKED_CATEGORY'),
    `expected both reasons, got ${codes.join(',')}`,
  );
});

test('C6.09', 'the frequency rule fires on the fourth expense in the window', async () => {
  const admin = session(co.adminCookie);
  // A company of its own so the count is not polluted by other cases.
  const made = await admin.post('/v1/admin/companies', {
    name: `QA Freq Co ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 1_000_000,
    frequencyMaxCount: 3,
    frequencyWindowMinutes: 60,
    blockedCategories: [],
  });
  eq(made.status, 201, 'create company');
  const key = made.json.apiKey.plaintext;
  // Chronological order: each spentAt is LATER than the last, so every earlier
  // expense sits inside the next one's backward-looking window (ADR-002).
  const base = Date.now() - 60_000;
  const decisions = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await submit(
      expense({ amount: 100, spentAt: new Date(base + i * 1000).toISOString() }),
      key,
    );
    eq(res.status, 201, `submit ${i + 1}`);
    decisions.push(res.json.decision);
  }
  eq(decisions.slice(0, 3).join(','), 'APPROVE,APPROVE,APPROVE', 'the first three');
  eq(decisions[3], 'REVIEW', 'the fourth');
  co.freqKey = key;
});

test('C6.10', 'the frequency reason names the window, the limit and the count', async () => {
  const res = await submit(expense({ amount: 100 }), co.freqKey);
  const hit = res.json.reasons.find((r) => (r.ruleCode ?? r.code) === 'FREQUENCY');
  check(hit, `no FREQUENCY reason: ${JSON.stringify(res.json.reasons)}`);
  const d = hit.detail ?? hit;
  eq(d.windowMinutes, 60, 'windowMinutes');
  eq(d.maxCount, 3, 'maxCount');
  check(d.countIncludingCurrent > 3, `countIncludingCurrent = ${d.countIncludingCurrent}`);
});

test('C6.11', 'an expense outside the window does not count', async () => {
  const admin = session(co.adminCookie);
  const made = await admin.post('/v1/admin/companies', {
    name: `QA Window Co ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 1_000_000,
    frequencyMaxCount: 2,
    frequencyWindowMinutes: 5,
    blockedCategories: [],
  });
  const key = made.json.apiKey.plaintext;
  const old = new Date(Date.now() - 1000 * 60 * 60).toISOString();
  await submit(expense({ amount: 100, spentAt: old }), key);
  await submit(expense({ amount: 100, spentAt: old }), key);
  await submit(expense({ amount: 100, spentAt: old }), key);
  const now = await submit(expense({ amount: 100 }), key);
  eq(
    now.json.decision,
    'APPROVE',
    `three old expenses leaked into the window: ${JSON.stringify(now.json.reasons)}`,
  );
});

test('C6.12', 'ten simultaneous submissions respect the frequency limit exactly', async () => {
  const admin = session(co.adminCookie);
  const made = await admin.post('/v1/admin/companies', {
    name: `QA Race Co ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 1_000_000,
    frequencyMaxCount: 3,
    frequencyWindowMinutes: 60,
    blockedCategories: [],
  });
  const key = made.json.apiKey.plaintext;
  // One shared spentAt: every request's backward window covers every other, so
  // the only thing under test is the lock, not ADR-002's ordering semantics.
  const spentAt = new Date().toISOString();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => submit(expense({ amount: 100, spentAt }), key)),
  );
  check(
    responses.every((r) => r.status === 201),
    `statuses: ${responses.map((r) => r.status).join(',')} -- ${responses.find((r) => r.status !== 201)?.text?.slice(0, 200)}`,
  );
  const approved = responses.filter((r) => r.json.decision === 'APPROVE').length;
  const reviewed = responses.filter((r) => r.json.decision === 'REVIEW').length;
  eq(approved, 3, `exactly three may auto-approve (approve=${approved}, review=${reviewed})`);
  eq(reviewed, 7, 'the rest must be flagged');
});

test('C6.13', 'an out-of-order arrival is not retro-counted (ADR-002)', async () => {
  const admin = session(co.adminCookie);
  const made = await admin.post('/v1/admin/companies', {
    name: `QA Order Co ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 1_000_000,
    frequencyMaxCount: 3,
    frequencyWindowMinutes: 60,
    blockedCategories: [],
  });
  const key = made.json.apiKey.plaintext;
  const t = Date.now();
  // Three recent expenses, then one that was SPENT earlier but arrives last.
  for (let i = 0; i < 3; i += 1) {
    await submit(expense({ amount: 100, spentAt: new Date(t - i * 1000).toISOString() }), key);
  }
  const late = await submit(
    expense({ amount: 100, spentAt: new Date(t - 10 * 60_000).toISOString() }),
    key,
  );
  eq(late.status, 201, 'status');
  eq(
    late.json.decision,
    'APPROVE',
    'its own backward window holds nothing, so it must not be flagged',
  );
});

test(
  'C6.14',
  'the policy snapshot is kept, and a replay still returns the original decision',
  async () => {
    const admin = session(co.adminCookie);
    const made = await admin.post('/v1/admin/companies', {
      name: `QA Snapshot Co ${RUN}`,
      currency: 'SAR',
      autoApproveLimitMinor: 50_000,
      frequencyMaxCount: 1_000,
      frequencyWindowMinutes: 60,
      blockedCategories: [],
    });
    const companyId = made.json.company.id;
    const key = made.json.apiKey.plaintext;
    const email = `qa-snap-${RUN}@qa.test`;
    const mk = await admin.post(`/v1/admin/companies/${companyId}/managers`, {
      displayName: 'QA Snapshot Manager',
      email,
      password: 'QaManagerPass!2026',
    });
    eq(mk.status, 201, `create manager (body: ${mk.text.slice(0, 200)})`);
    const mgr = session((await login({ email, password: 'QaManagerPass!2026' })).cookie);

    const body = expense({ amount: 50_001 });
    const first = await submit(body, key);
    eq(first.json.decision, 'REVIEW', 'before the policy change');

    const patch = await mgr.patch('/v1/policy', { autoApproveLimitMinor: 200_000 });
    eq(patch.status, 200, `policy update (body: ${patch.text.slice(0, 200)})`);

    const fresh = await submit(expense({ amount: 50_001 }), key);
    eq(
      fresh.json.decision,
      'APPROVE',
      `a new expense must be judged by the new policy (reasons ${JSON.stringify(fresh.json.reasons)})`,
    );

    const replay = await submit(body, key);
    eq(replay.status, 200, 'replay status');
    eq(replay.json.decision, 'REVIEW', 'history must not be rewritten');

    const read = await mgr.get(`/v1/expenses/${id(first)}`);
    eq(read.status, 200, 'read');
    const snap =
      read.json.policySnapshot ?? read.json.snapshot ?? read.json.expense?.policySnapshot;
    check(snap, `no policy snapshot in ${JSON.stringify(read.json).slice(0, 400)}`);
    eq(snap.autoApproveLimitMinor, 50_000, 'the snapshot holds the old limit');
  },
);

test(
  'C6.15',
  'OBSERVATION: concurrent arrivals milliseconds apart can exceed the limit',
  async () => {
    // Documents risk R-11 under ordinary concurrent traffic rather than deliberate
    // back-dating. Ten expenses spread across ten milliseconds, limit 3. Because
    // each window looks backward from its own spentAt and arrival order is
    // arbitrary, more than three can auto-approve. Recorded, not asserted as a
    // pass/fail: this test reports the number it saw.
    const admin = session(co.adminCookie);
    const made = await admin.post('/v1/admin/companies', {
      name: `QA Skew Co ${RUN}`,
      currency: 'SAR',
      autoApproveLimitMinor: 1_000_000,
      frequencyMaxCount: 3,
      frequencyWindowMinutes: 60,
      blockedCategories: [],
    });
    const key = made.json.apiKey.plaintext;
    const t = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        submit(expense({ amount: 100, spentAt: new Date(t + i).toISOString() }), key),
      ),
    );
    const approved = responses.filter((r) => r.json?.decision === 'APPROVE').length;
    console.log(`      note: ${approved} of 10 auto-approved against a limit of 3`);
    check(
      responses.every((r) => r.status === 201),
      'every submission must still succeed',
    );
  },
);

run('CYCLE 4-6  submission validation, idempotency, policy engine');
