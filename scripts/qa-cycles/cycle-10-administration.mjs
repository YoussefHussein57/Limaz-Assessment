/* Cycle 10: platform administration - companies, API key lifecycle, managers. */
import { apiKey, login, session, expense, test, check, eq, run, RUN } from './lib.mjs';

const submit = (body, key) => apiKey(key, '/v1/expenses', { method: 'POST', body });

let A = null;
let co = null;

test('C10.00', 'sign in as the platform administrator', async () => {
  A = session((await login('admin')).cookie);
  const res = await A.get('/v1/admin/companies');
  eq(res.status, 200, 'status');
});

test('C10.01', 'creating a company returns its policy and a key shown exactly once', async () => {
  const res = await A.post('/v1/admin/companies', {
    name: `QA Admin Co ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 40_000,
    frequencyMaxCount: 5,
    frequencyWindowMinutes: 30,
    blockedCategories: ['ALCOHOL'],
  });
  eq(res.status, 201, `status (${res.text.slice(0, 200)})`);
  const { company, apiKey: issued } = res.json;
  check(company?.id, 'no company id');
  eq(company.policy.autoApproveLimitMinor, 40_000, 'policy limit');
  eq(company.policy.frequencyWindowMinutes, 30, 'policy window');
  check(typeof issued.plaintext === 'string', 'no plaintext key');
  check(issued.plaintext.startsWith('lmz_'), `odd key shape: ${issued.plaintext.slice(0, 8)}`);
  co = { id: company.id, key: issued.plaintext, keyId: issued.key.id };

  const again = await A.get(`/v1/admin/companies/${co.id}`);
  eq(again.status, 200, 'detail');
  check(!again.text.includes(co.key), 'the raw key is returned a second time');
});

test('C10.02', 'response headers forbid caching on the responses that carry a key', async () => {
  const res = await A.post('/v1/admin/companies', {
    name: `QA Cache Co ${RUN}`,
    currency: 'SAR',
  });
  eq(res.status, 201, 'status');
  check(
    /no-store/i.test(res.headers['cache-control'] || ''),
    `cache-control was "${res.headers['cache-control']}"`,
  );
});

test('C10.03', 'the key created with the company authenticates immediately', async () => {
  const res = await submit(expense({ amount: 100 }), co.key);
  eq(res.status, 201, `status (${res.text.slice(0, 200)})`);
  eq(res.json.decision, 'APPROVE', 'decision');
});

test('C10.04', 'the policy created in the same transaction is what decides', async () => {
  const res = await submit(expense({ amount: 40_001 }), co.key);
  eq(res.json.decision, 'REVIEW', 'over the 400.00 limit');
  const blocked = await submit(expense({ amount: 100, category: 'ALCOHOL' }), co.key);
  eq(blocked.json.decision, 'REJECT', 'blocked category');
});

const badCompanies = [
  ['C10.05', 'an empty name', { name: '' }],
  ['C10.06', 'a name of only whitespace', { name: '   ' }],
  ['C10.07', 'a bad currency', { name: 'X', currency: 'SARS' }],
  ['C10.08', 'a negative limit', { name: 'X', autoApproveLimitMinor: -1 }],
  ['C10.09', 'a fractional limit', { name: 'X', autoApproveLimitMinor: 1.5 }],
  ['C10.10', 'a zero frequency count', { name: 'X', frequencyMaxCount: 0 }],
  ['C10.11', 'a window beyond 24 hours', { name: 'X', frequencyWindowMinutes: 2000 }],
  ['C10.12', 'an unknown field', { name: 'X', owner: 'me' }],
];

for (const [tid, name, body] of badCompanies) {
  test(tid, `creating a company with ${name} is refused, never a 500`, async () => {
    const res = await A.post('/v1/admin/companies', body);
    check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
    eq(res.status, 400, `status (${res.text.slice(0, 160)})`);
  });
}

test('C10.13', 'issuing a second key leaves the first one working', async () => {
  const res = await A.post(`/v1/admin/companies/${co.id}/api-keys`, {});
  eq(res.status, 201, `status (${res.text.slice(0, 200)})`);
  const second = res.json.plaintext ?? res.json.apiKey?.plaintext;
  check(second, `no plaintext in ${res.text.slice(0, 200)}`);
  eq((await submit(expense({ amount: 100 }), co.key)).status, 201, 'the first key');
  eq((await submit(expense({ amount: 100 }), second)).status, 201, 'the second key');
  co.second = second;
  co.secondId = (res.json.key ?? res.json.apiKey?.key)?.id;
});

test(
  'C10.14',
  'rotation issues a new key and keeps the old one alive in its grace window',
  async () => {
    const res = await A.post(`/v1/admin/companies/${co.id}/api-keys/${co.keyId}/rotate`, {});
    eq(res.status, 200, `status (${res.text.slice(0, 200)})`);
    const replacement = res.json.plaintext ?? res.json.apiKey?.plaintext;
    check(replacement, `no replacement key in ${res.text.slice(0, 200)}`);
    eq((await submit(expense({ amount: 100 }), replacement)).status, 201, 'the new key works');
    eq((await submit(expense({ amount: 100 }), co.key)).status, 201, 'the old key is in grace');
    co.rotated = replacement;
  },
);

test('C10.15', 'the rotated key reports an expiry roughly 24 hours out', async () => {
  const res = await A.get(`/v1/admin/companies/${co.id}/api-keys`);
  eq(res.status, 200, 'status');
  const keys = res.json.items ?? res.json.keys ?? res.json;
  const old = keys.find((k) => k.id === co.keyId);
  check(old, `the rotated key is missing from ${res.text.slice(0, 300)}`);
  check(old.expiresAt, `no expiresAt on the rotated key: ${JSON.stringify(old)}`);
  const hours = (new Date(old.expiresAt) - Date.now()) / 3_600_000;
  check(hours > 23 && hours < 25, `grace window is ${hours.toFixed(1)}h, expected ~24h`);
});

test('C10.16', 'revoking a key stops it immediately', async () => {
  const res = await A.post(`/v1/admin/companies/${co.id}/api-keys/${co.secondId}/revoke`, {});
  eq(res.status, 200, `status (${res.text.slice(0, 200)})`);
  const after = await submit(expense({ amount: 100 }), co.second);
  eq(after.status, 401, 'the revoked key still authenticates');
});

test('C10.17', 'revoking a key twice is refused cleanly, never a 500', async () => {
  const res = await A.post(`/v1/admin/companies/${co.id}/api-keys/${co.secondId}/revoke`, {});
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  check([200, 404, 409].includes(res.status), `status ${res.status}`);
});

test(
  'C10.18',
  "a key id belonging to another company cannot be revoked through this company's path",
  async () => {
    const other = await A.post('/v1/admin/companies', {
      name: `QA Victim Co ${RUN}`,
      currency: 'SAR',
    });
    const victimKeyId = other.json.apiKey.key.id;
    const victimKey = other.json.apiKey.plaintext;
    const res = await A.post(`/v1/admin/companies/${co.id}/api-keys/${victimKeyId}/revoke`, {});
    eq(res.status, 404, `status (${res.text.slice(0, 200)})`);
    eq(
      (await submit(expense({ amount: 100 }), victimKey)).status,
      201,
      'the victim key was revoked',
    );
  },
);

test('C10.19', 'an unknown company id is 404, never a 500', async () => {
  const res = await A.get('/v1/admin/companies/01a1fe00-0000-7000-8000-000000000000');
  check(res.status !== 500, 'server error');
  eq(res.status, 404, 'status');
});

test('C10.20', 'a malformed company id is refused cleanly', async () => {
  const res = await A.get('/v1/admin/companies/not-a-uuid');
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  check([400, 404].includes(res.status), `status ${res.status}`);
});

test('C10.21', 'a manager can be created and can sign in', async () => {
  const email = `qa-admin-mgr-${RUN}@qa.test`;
  const res = await A.post(`/v1/admin/companies/${co.id}/managers`, {
    displayName: 'QA Admin Manager',
    email,
    password: 'QaManagerPass!2026',
  });
  eq(res.status, 201, `status (${res.text.slice(0, 200)})`);
  check(!res.text.includes('QaManagerPass!2026'), 'the password was echoed back');
  eq(res.json.manager?.role ?? res.json.role, 'MANAGER', 'role');
  const who = await login({ email, password: 'QaManagerPass!2026' });
  const me = await session(who.cookie).get('/v1/auth/me');
  eq(me.status, 200, 'the new manager can sign in');
  co.managerEmail = email;
  co.managerCookie = who.cookie;
});

test('C10.22', 'the new manager is scoped to their own company only', async () => {
  const s = session(co.managerCookie);
  const policy = await s.get('/v1/policy');
  eq(policy.status, 200, 'own policy');
  eq((policy.json.policy ?? policy.json).autoApproveLimitMinor, 40_000, 'their own limit');
  eq((await s.get('/v1/admin/companies')).status, 403, 'admin area');
});

test('C10.23', 'a duplicate manager email is refused, never a 500', async () => {
  const res = await A.post(`/v1/admin/companies/${co.id}/managers`, {
    displayName: 'QA Duplicate',
    email: co.managerEmail,
    password: 'QaManagerPass!2026',
  });
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  check([409, 400].includes(res.status), `status ${res.status} (${res.text.slice(0, 160)})`);
});

test('C10.24', 'the same email cannot be reused in a different company either', async () => {
  const other = await A.post('/v1/admin/companies', {
    name: `QA Second Co ${RUN}`,
    currency: 'SAR',
  });
  const res = await A.post(`/v1/admin/companies/${other.json.company.id}/managers`, {
    displayName: 'QA Cross',
    email: co.managerEmail,
    password: 'QaManagerPass!2026',
  });
  check(res.status !== 500, 'server error');
  check([409, 400].includes(res.status), `status ${res.status}`);
});

const badManagers = [
  ['C10.25', 'a short password', { password: 'short' }],
  ['C10.26', 'a malformed email', { email: 'not-an-email' }],
  ['C10.27', 'an empty display name', { displayName: '' }],
  ['C10.28', 'a caller-supplied role', { role: 'ADMIN' }],
  ['C10.29', 'a caller-supplied companyId', { companyId: '00000000-0000-0000-0000-000000000000' }],
];

for (const [tid, name, patch] of badManagers) {
  test(tid, `creating a manager with ${name} is refused, never a 500`, async () => {
    const res = await A.post(`/v1/admin/companies/${co.id}/managers`, {
      displayName: 'QA Bad',
      email: `qa-bad-${tid}-${RUN}@qa.test`,
      password: 'QaManagerPass!2026',
      ...patch,
    });
    check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
    eq(res.status, 400, `status (${res.text.slice(0, 160)})`);
  });
}

test('C10.30', 'creating a manager for an unknown company is 404', async () => {
  const res = await A.post('/v1/admin/companies/01a1fe00-0000-7000-8000-000000000000/managers', {
    displayName: 'QA Nobody',
    email: `qa-nobody-${RUN}@qa.test`,
    password: 'QaManagerPass!2026',
  });
  check(res.status !== 500, 'server error');
  eq(res.status, 404, 'status');
});

test('C10.31', 'the company list reports how many keys can authenticate right now', async () => {
  const res = await A.get('/v1/admin/companies?limit=100');
  eq(res.status, 200, 'status');
  const items = res.json.items ?? res.json.companies ?? res.json;
  const mine = items.find((c) => c.id === co.id);
  check(mine, 'the company is missing from the list');
  check(typeof mine.activeApiKeys === 'number', `no activeApiKeys: ${JSON.stringify(mine)}`);
});

test('C10.32', 'the manager listing never carries a password hash', async () => {
  const res = await A.get(`/v1/admin/companies/${co.id}/managers`);
  eq(res.status, 200, 'status');
  check(!/\$2[aby]\$/.test(res.text), 'a bcrypt hash was returned');
  check(!/passwordHash/i.test(res.text), 'a passwordHash field was returned');
});

test('C10.33', 'admin paging over companies is well formed', async () => {
  const page = await A.get('/v1/admin/companies?limit=1');
  eq(page.status, 200, 'status');
  eq(page.json.items.length, 1, 'page size');
  check('nextCursor' in page.json, 'no nextCursor field');
  if (page.json.nextCursor) {
    const next = await A.get(
      `/v1/admin/companies?limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`,
    );
    eq(next.status, 200, 'second page');
    check(next.json.items[0].id !== page.json.items[0].id, 'the second page repeats the first row');
  }
});

run('CYCLE 10  platform administration');
