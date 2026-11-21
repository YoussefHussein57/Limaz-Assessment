/* Cycle 1: health & infrastructure.  Cycle 2: authentication & authorization.
   Cycle 3: tenant isolation. */
import {
  call,
  browser,
  apiKey,
  login,
  session,
  expense,
  test,
  check,
  eq,
  run,
  NILE_KEY,
  DELTA_KEY,
  ACCOUNTS,
  RUN,
} from './lib.mjs';

/* ---------------- Cycle 1: health ---------------- */

test('C1.01', 'GET /health reports ok with database up', async () => {
  const res = await call('/health');
  eq(res.status, 200, 'status');
  eq(res.json.status, 'ok', 'body.status');
  eq(res.json.checks.database.status, 'up', 'database check');
  check(typeof res.json.uptimeSeconds === 'number', 'uptimeSeconds must be a number');
});

test('C1.02', 'unknown route answers 404 as JSON, never an HTML stack trace', async () => {
  const res = await call('/v1/does-not-exist');
  eq(res.status, 404, 'status');
  check(res.json !== null, `expected a JSON body, got: ${res.text.slice(0, 120)}`);
  check(!/<html|at Object|node_modules/i.test(res.text), 'response leaked a stack trace or HTML');
});

test('C1.03', 'no server banner / framework fingerprint header leaked', async () => {
  const res = await call('/health');
  check(!res.headers['x-powered-by'], `x-powered-by leaked: ${res.headers['x-powered-by']}`);
});

/* ---------------- Cycle 2: authentication ---------------- */

test('C2.01', 'POST /v1/expenses with no credential is 401', async () => {
  const res = await call('/v1/expenses', {
    method: 'POST',
    headers: { 'x-limaz-client': '1' },
    body: expense(),
  });
  eq(res.status, 401, 'status');
});

test('C2.01b', 'a credential-less POST with no CSRF header answers 403 before 401', async () => {
  const res = await call('/v1/expenses', { method: 'POST', body: expense() });
  eq(res.status, 403, 'status');
  eq(res.json.error, 'csrf_header_required', 'error');
});

test('C2.02', 'POST /v1/expenses with an invalid API key is 401', async () => {
  const res = await apiKey('lmz_dev_not_a_real_key_000000000000000', '/v1/expenses', {
    method: 'POST',
    body: expense(),
  });
  eq(res.status, 401, 'status');
});

test('C2.03', 'POST /v1/expenses with a valid API key is accepted', async () => {
  const res = await apiKey(NILE_KEY, '/v1/expenses', { method: 'POST', body: expense() });
  eq(res.status, 201, `status (body: ${res.text.slice(0, 200)})`);
  check(['APPROVE', 'REVIEW', 'REJECT'].includes(res.json.decision), 'decision present');
});

test('C2.04', 'an API key cannot read the manager dashboard (caller type)', async () => {
  const res = await apiKey(NILE_KEY, '/v1/dashboard/summary');
  check(res.status === 403 || res.status === 401, `expected 401/403, got ${res.status}`);
});

test('C2.05', 'a browser session cannot submit an expense (caller type)', async () => {
  const { cookie } = await login('nile');
  const res = await session(cookie).post('/v1/expenses', expense());
  check(res.status === 403 || res.status === 401, `expected 401/403, got ${res.status}`);
});

test('C2.06', 'login with a wrong password is 401 and sets no cookie', async () => {
  const res = await browser('/v1/auth/login', {
    method: 'POST',
    body: { email: ACCOUNTS.nile.email, password: 'WrongPassword!2026' },
  });
  eq(res.status, 401, 'status');
  eq(res.setCookie.length, 0, 'Set-Cookie count');
});

test(
  'C2.07',
  'login with an unknown email is 401 and indistinguishable from a wrong password',
  async () => {
    const unknown = await browser('/v1/auth/login', {
      method: 'POST',
      body: { email: 'nobody@nowhere.test', password: 'WrongPassword!2026' },
    });
    const wrong = await browser('/v1/auth/login', {
      method: 'POST',
      body: { email: ACCOUNTS.nile.email, password: 'WrongPassword!2026' },
    });
    eq(unknown.status, 401, 'unknown-email status');
    eq(
      JSON.stringify(unknown.json),
      JSON.stringify(wrong.json),
      'user enumeration: the two refusals differ',
    );
  },
);

test('C2.08', 'login succeeds and issues an HttpOnly, SameSite, Secure cookie', async () => {
  const res = await browser('/v1/auth/login', { method: 'POST', body: ACCOUNTS.nile });
  eq(res.status, 200, `status (body: ${res.text.slice(0, 200)})`);
  check(res.setCookie.length > 0, 'no Set-Cookie');
  const c = res.setCookie[0];
  check(/HttpOnly/i.test(c), `cookie not HttpOnly: ${c}`);
  check(/SameSite=(Lax|Strict)/i.test(c), `cookie SameSite missing: ${c}`);
  check(/Secure/i.test(c), `cookie not Secure: ${c}`);
});

test('C2.09', 'login without the x-limaz-client header is refused (CSRF)', async () => {
  const res = await call('/v1/auth/login', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
    body: ACCOUNTS.nile,
  });
  eq(res.status, 403, 'status');
  eq(res.json.error, 'csrf_header_required', 'error code');
});

test('C2.10', 'login from a foreign Origin is refused', async () => {
  const res = await call('/v1/auth/login', {
    method: 'POST',
    headers: { origin: 'http://evil.example', 'x-limaz-client': '1' },
    body: ACCOUNTS.nile,
  });
  eq(res.status, 403, 'status');
  eq(res.json.error, 'cross_origin_rejected', 'error code');
});

test('C2.11', 'GET /v1/auth/me returns the signed-in manager and their company', async () => {
  const { cookie } = await login('nile');
  const res = await session(cookie).get('/v1/auth/me');
  eq(res.status, 200, 'status');
  eq(res.json.email ?? res.json.user?.email, ACCOUNTS.nile.email, 'email');
});

test('C2.12', 'logout invalidates the session immediately', async () => {
  const { cookie } = await login('nile');
  const s = session(cookie);
  eq((await s.get('/v1/auth/me')).status, 200, 'before logout');
  const out = await s.post('/v1/auth/logout', {});
  check(out.status === 200 || out.status === 204, `logout status ${out.status}`);
  const after = await s.get('/v1/auth/me');
  eq(after.status, 401, 'after logout');
});

test('C2.13', 'a forged session cookie is refused', async () => {
  const res = await browser('/v1/auth/me', {
    cookie: 'limaz_session=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  eq(res.status, 401, 'status');
});

test('C2.14', 'a manager cannot reach the admin area', async () => {
  const { cookie } = await login('nile');
  const res = await session(cookie).get('/v1/admin/companies');
  eq(res.status, 403, 'status');
});

test('C2.15', 'a manager cannot create a company', async () => {
  const { cookie } = await login('nile');
  const res = await session(cookie).post('/v1/admin/companies', {
    name: 'Should Not Exist',
    autoApproveLimitMinor: 1000,
    frequencyMaxCount: 3,
    frequencyWindowMinutes: 60,
    blockedCategories: [],
  });
  eq(res.status, 403, 'status');
});

test('C2.16', 'the platform admin has no company scope on manager endpoints', async () => {
  const { cookie } = await login('admin');
  const res = await session(cookie).get('/v1/dashboard/summary');
  check(res.status === 403 || res.status === 400, `expected 400/403, got ${res.status}`);
  check(res.status !== 500, 'the admin principal caused a server error');
});

test('C2.17', 'the admin can list companies', async () => {
  const { cookie } = await login('admin');
  const res = await session(cookie).get('/v1/admin/companies');
  eq(res.status, 200, 'status');
  const list = Array.isArray(res.json) ? res.json : (res.json.items ?? res.json.companies);
  check(Array.isArray(list) && list.length >= 2, 'at least the two seeded companies');
});

test('C2.18', 'no credential is echoed back in any login or key response', async () => {
  const res = await browser('/v1/auth/login', { method: 'POST', body: ACCOUNTS.nile });
  check(!res.text.includes(ACCOUNTS.nile.password), 'the password was echoed in the response');
});

/* ---------------- Cycle 3: tenant isolation ---------------- */

test('C3.01', "one company's expense id is 404 for another company's key", async () => {
  const mine = await apiKey(NILE_KEY, '/v1/expenses', { method: 'POST', body: expense() });
  eq(mine.status, 201, 'setup submit');
  const id = mine.json.expenseId ?? mine.json.id ?? mine.json.expense?.id;
  check(id, `could not find the expense id in ${JSON.stringify(mine.json).slice(0, 200)}`);
  // Reads are session-scoped by design (API keys write, managers read), so
  // isolation is proven with two manager sessions instead of two keys.
  const nile = await login('nile');
  const ours = await session(nile.cookie).get(`/v1/expenses/${id}`);
  eq(ours.status, 200, 'own read');
  const delta = await login('delta');
  const theirs = await session(delta.cookie).get(`/v1/expenses/${id}`);
  eq(theirs.status, 404, 'cross-tenant read must be 404, not 403');
  const withKey = await apiKey(DELTA_KEY, `/v1/expenses/${id}`);
  eq(withKey.status, 403, 'an API key may not read expenses at all');
});

test('C3.02', "a manager cannot open another company's expense", async () => {
  const mine = await apiKey(NILE_KEY, '/v1/expenses', { method: 'POST', body: expense() });
  const id = mine.json.expenseId ?? mine.json.id;
  const delta = await login('delta');
  const res = await session(delta.cookie).get(`/v1/expenses/${id}`);
  eq(res.status, 404, 'status');
});

test('C3.03', 'a body-supplied companyId is refused outright', async () => {
  const res = await apiKey(NILE_KEY, '/v1/expenses', {
    method: 'POST',
    body: { ...expense(), companyId: '00000000-0000-0000-0000-000000000000' },
  });
  eq(res.status, 400, 'status');
});

test('C3.04', 'a body-supplied decision is refused outright', async () => {
  const res = await apiKey(NILE_KEY, '/v1/expenses', {
    method: 'POST',
    body: { ...expense(), decision: 'APPROVE' },
  });
  eq(res.status, 400, 'status');
});

test('C3.05', 'the same externalId may exist in both companies independently', async () => {
  const shared = `${RUN}-shared-${Date.now()}`;
  const a = await apiKey(NILE_KEY, '/v1/expenses', {
    method: 'POST',
    body: expense({ externalId: shared }),
  });
  const b = await apiKey(DELTA_KEY, '/v1/expenses', {
    method: 'POST',
    body: expense({ externalId: shared }),
  });
  eq(a.status, 201, 'nile');
  eq(b.status, 201, 'delta');
  check(
    (a.json.expenseId ?? a.json.id) !== (b.json.expenseId ?? b.json.id),
    'the two companies share one expense row',
  );
});

test('C3.06', 'a company never sees another company expense in its own list', async () => {
  const shared = `${RUN}-list-${Date.now()}`;
  await apiKey(DELTA_KEY, '/v1/expenses', {
    method: 'POST',
    body: expense({ externalId: shared, merchant: 'DELTA-ONLY-MERCHANT' }),
  });
  const nile = await login('nile');
  const res = await session(nile.cookie).get('/v1/expenses?q=DELTA-ONLY-MERCHANT&limit=50');
  eq(res.status, 200, 'status');
  const items = res.json.items ?? res.json.expenses ?? [];
  eq(items.length, 0, 'leaked rows');
});

run('CYCLE 1-3  health, authentication, tenant isolation');
