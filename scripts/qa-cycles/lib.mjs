/** Shared black-box test harness for the LIMAZ API (QA cycle). */

const API = process.env.QA_API || 'http://localhost:3001';
const WEB = process.env.QA_WEB || 'http://localhost:3000';
const ORIGIN = process.env.QA_ORIGIN || 'http://localhost:3000';

const NILE_KEY = 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s';
const DELTA_KEY = 'lmz_dev_delta_3Xn9TbVcA7pKmR2wQy8ZsL4dHe6uJ5g';

const ACCOUNTS = {
  nile: { email: 'manager@nile-logistics.test', password: 'NileManager!2026' },
  delta: { email: 'manager@delta-consulting.test', password: 'DeltaManager!2026' },
  admin: { email: 'admin@limaz.test', password: 'PlatformAdmin!2026' },
};

const RUN = process.env.QA_RUN || `qa${Date.now().toString(36)}`;

const results = [];
let only = null;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--only=')) only = a.slice(7);
}

async function call(path, opts = {}) {
  const { method = 'GET', headers = {}, body, cookie, raw } = opts;
  const h = { ...headers };
  if (body !== undefined && !h['content-type'] && !h['Content-Type']) {
    h['content-type'] = 'application/json';
  }
  if (cookie) h.cookie = cookie;
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: h,
    body: payload,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return {
    status: res.status,
    json,
    text,
    headers: Object.fromEntries(res.headers.entries()),
    setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
  };
}

/** Browser-shaped call: Origin + CSRF header, like the web app sends. */
function browser(path, opts = {}) {
  return call(path, {
    ...opts,
    headers: { origin: ORIGIN, 'x-limaz-client': '1', ...(opts.headers || {}) },
  });
}

function apiKey(key, path, opts = {}) {
  return call(path, { ...opts, headers: { 'x-api-key': key, ...(opts.headers || {}) } });
}

async function login(which) {
  const acct = typeof which === 'string' ? ACCOUNTS[which] : which;
  const res = await browser('/v1/auth/login', { method: 'POST', body: acct });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login failed for ${acct.email}: ${res.status} ${res.text}`);
  }
  const cookies = res.setCookie.map((c) => c.split(';')[0]).join('; ');
  return { cookie: cookies, me: res.json, raw: res };
}

function session(cookie) {
  return {
    get: (p, o = {}) => browser(p, { ...o, cookie }),
    post: (p, body, o = {}) => browser(p, { ...o, method: 'POST', body, cookie }),
    patch: (p, body, o = {}) => browser(p, { ...o, method: 'PATCH', body, cookie }),
  };
}

function expense(overrides = {}) {
  return {
    externalId: `${RUN}-${Math.random().toString(36).slice(2, 10)}`,
    employeeId: 'emp-qa-1',
    amount: 10000,
    currency: 'SAR',
    merchant: 'QA Merchant',
    category: 'TRAVEL',
    spentAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

const tests = [];
function test(id, name, fn) {
  tests.push({ id, name, fn });
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function run(cycleName) {
  const started = Date.now();
  console.log(`\n===== ${cycleName} =====  (run id ${RUN})\n`);
  for (const t of tests) {
    if (only && !t.id.startsWith(only)) continue;
    const t0 = Date.now();
    try {
      await t.fn();
      results.push({ ...t, ok: true, ms: Date.now() - t0 });
      console.log(`PASS  ${t.id}  ${t.name}  (${Date.now() - t0}ms)`);
    } catch (error) {
      results.push({ ...t, ok: false, ms: Date.now() - t0, error: error.message });
      console.log(`FAIL  ${t.id}  ${t.name}`);
      console.log(`      -> ${error.message.split('\n').join('\n      ')}`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n----- ${cycleName}: ${results.length - failed.length}/${results.length} passed in ${Date.now() - started}ms -----`,
  );
  if (failed.length) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  ${f.id}  ${f.name}\n      ${f.error}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

export {
  API,
  WEB,
  ORIGIN,
  NILE_KEY,
  DELTA_KEY,
  ACCOUNTS,
  RUN,
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
};
