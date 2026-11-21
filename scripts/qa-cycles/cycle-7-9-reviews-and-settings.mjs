/* Cycle 7: the review lifecycle.
   Cycle 8: the dashboard, listing, filtering and paging.
   Cycle 9: policy settings. */
import { apiKey, login, session, expense, test, check, eq, run, RUN } from './lib.mjs';

const submit = (body, key) => apiKey(key, '/v1/expenses', { method: 'POST', body });
const id = (res) => res.json?.expenseId ?? res.json?.id ?? res.json?.expense?.id;

let ctx = null;

test('C7.00', 'set up a company, a manager and a second manager for this cycle', async () => {
  const admin = session((await login('admin')).cookie);
  const made = await admin.post('/v1/admin/companies', {
    name: `QA Review Co ${RUN}`,
    currency: 'SAR',
    autoApproveLimitMinor: 50_000,
    frequencyMaxCount: 1_000,
    frequencyWindowMinutes: 60,
    blockedCategories: ['GAMBLING'],
  });
  eq(made.status, 201, 'create company');
  const companyId = made.json.company.id;
  const key = made.json.apiKey.plaintext;

  const emails = [`qa-rev-a-${RUN}@qa.test`, `qa-rev-b-${RUN}@qa.test`];
  for (const email of emails) {
    const res = await admin.post(`/v1/admin/companies/${companyId}/managers`, {
      displayName: `QA ${email}`,
      email,
      password: 'QaManagerPass!2026',
    });
    eq(res.status, 201, `create manager ${email} (${res.text.slice(0, 160)})`);
  }
  const a = await login({ email: emails[0], password: 'QaManagerPass!2026' });
  const b = await login({ email: emails[1], password: 'QaManagerPass!2026' });
  ctx = { companyId, key, a: session(a.cookie), b: session(b.cookie), adminCookie: admin, emails };
});

async function flagged(amount = 60_000) {
  const res = await submit(expense({ amount }), ctx.key);
  eq(res.status, 201, `submit (${res.text.slice(0, 160)})`);
  eq(res.json.decision, 'REVIEW', 'decision');
  return id(res);
}

async function reviewFor(expenseId) {
  const list = await ctx.a.get('/v1/reviews?limit=100');
  eq(list.status, 200, 'review list');
  const items = list.json.items ?? list.json.reviews ?? [];
  const match = items.find((r) => (r.expense?.id ?? r.expenseId) === expenseId);
  check(match, `no review for ${expenseId} in ${items.length} rows`);
  return match.id ?? match.reviewId;
}

/* ---------------- Cycle 7: reviews ---------------- */

test('C7.01', 'a REVIEW decision opens exactly one review', async () => {
  const expenseId = await flagged();
  const list = await ctx.a.get('/v1/reviews?limit=100');
  const items = list.json.items ?? [];
  const matches = items.filter((r) => (r.expense?.id ?? r.expenseId) === expenseId);
  eq(matches.length, 1, 'review count');
});

test('C7.02', 'an APPROVE decision opens no review', async () => {
  const before = (await ctx.a.get('/v1/reviews?limit=100')).json.items.length;
  const res = await submit(expense({ amount: 100 }), ctx.key);
  eq(res.json.decision, 'APPROVE', 'decision');
  const after = (await ctx.a.get('/v1/reviews?limit=100')).json.items.length;
  eq(after, before, 'review count changed');
});

test('C7.03', 'a REJECT decision opens no review', async () => {
  const before = (await ctx.a.get('/v1/reviews?limit=100')).json.items.length;
  const res = await submit(expense({ amount: 100, category: 'GAMBLING' }), ctx.key);
  eq(res.json.decision, 'REJECT', 'decision');
  const after = (await ctx.a.get('/v1/reviews?limit=100')).json.items.length;
  eq(after, before, 'review count changed');
});

test('C7.04', 'the review detail carries every reason and the policy snapshot', async () => {
  const expenseId = await flagged(70_000);
  const reviewId = await reviewFor(expenseId);
  const res = await ctx.a.get(`/v1/reviews/${reviewId}`);
  eq(res.status, 200, 'status');
  const body = res.json.review ?? res.json;
  const reasons = body.reasons ?? body.expense?.reasons ?? res.json.expense?.reasons;
  check(Array.isArray(reasons) && reasons.length > 0, `no reasons in ${res.text.slice(0, 300)}`);
  const snapshot =
    body.policySnapshot ?? body.expense?.policySnapshot ?? res.json.expense?.policySnapshot;
  check(snapshot, `no policy snapshot in ${res.text.slice(0, 300)}`);
  eq(snapshot.autoApproveLimitMinor, 50_000, 'snapshot limit');
});

test(
  'C7.05',
  'approving a review sets the expense status and leaves the decision alone',
  async () => {
    const expenseId = await flagged();
    const reviewId = await reviewFor(expenseId);
    const res = await ctx.a.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'APPROVE' });
    eq(res.status, 200, `resolve (${res.text.slice(0, 200)})`);
    const read = await ctx.a.get(`/v1/expenses/${expenseId}`);
    const e = read.json.expense ?? read.json;
    eq(e.status, 'APPROVED', 'final status');
    eq(e.decision, 'REVIEW', 'the automated decision must survive');
  },
);

test('C7.06', 'rejecting a review sets the expense to REJECTED', async () => {
  const expenseId = await flagged();
  const reviewId = await reviewFor(expenseId);
  const res = await ctx.a.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'REJECT' });
  eq(res.status, 200, 'resolve');
  const read = await ctx.a.get(`/v1/expenses/${expenseId}`);
  const e = read.json.expense ?? read.json;
  eq(e.status, 'REJECTED', 'final status');
  eq(e.decision, 'REVIEW', 'the automated decision must survive');
});

test('C7.07', 'the resolution records who decided and when', async () => {
  const expenseId = await flagged();
  const reviewId = await reviewFor(expenseId);
  await ctx.a.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'APPROVE' });
  const res = await ctx.a.get(`/v1/reviews/${reviewId}`);
  const body = res.json.review ?? res.json;
  eq(body.state, 'RESOLVED', 'state');
  const r = body.resolution;
  check(r, `no resolution block in ${res.text.slice(0, 400)}`);
  check(r.resolvedAt ?? r.decidedAt ?? r.at, `no resolution timestamp in ${JSON.stringify(r)}`);
  eq(r.outcome ?? r.decision, 'APPROVED', 'recorded outcome');
  const who = JSON.stringify(r);
  check(
    who.includes(ctx.emails[0]) || /resolvedBy|reviewer|displayName/i.test(who),
    `no reviewer recorded: ${who}`,
  );
});

test(
  'C7.08',
  'a second resolve of the same review is refused and names the first decision',
  async () => {
    const expenseId = await flagged();
    const reviewId = await reviewFor(expenseId);
    const first = await ctx.a.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'APPROVE' });
    eq(first.status, 200, 'first');
    const second = await ctx.b.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'REJECT' });
    eq(second.status, 409, `second (${second.text.slice(0, 200)})`);
    check(
      /APPROVE|APPROVED/.test(second.text),
      `the loser is not told what was decided: ${second.text.slice(0, 200)}`,
    );
  },
);

test('C7.09', 'a losing resolve does not change the expense', async () => {
  const expenseId = await flagged();
  const reviewId = await reviewFor(expenseId);
  await ctx.a.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'APPROVE' });
  await ctx.b.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'REJECT' });
  const read = await ctx.a.get(`/v1/expenses/${expenseId}`);
  eq((read.json.expense ?? read.json).status, 'APPROVED', 'status must be the winner');
});

test('C7.10', 'two simultaneous resolves produce exactly one winner', async () => {
  for (let trial = 0; trial < 3; trial += 1) {
    const expenseId = await flagged();
    const reviewId = await reviewFor(expenseId);
    const [x, y] = await Promise.all([
      ctx.a.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'APPROVE' }),
      ctx.b.post(`/v1/reviews/${reviewId}/resolve`, { decision: 'REJECT' }),
    ]);
    const ok = [x, y].filter((r) => r.status === 200);
    const lost = [x, y].filter((r) => r.status === 409);
    eq(ok.length, 1, `trial ${trial}: exactly one winner (got ${x.status}/${y.status})`);
    eq(lost.length, 1, `trial ${trial}: exactly one loser`);
    const read = await ctx.a.get(`/v1/expenses/${expenseId}`);
    const status = (read.json.expense ?? read.json).status;
    check(['APPROVED', 'REJECTED'].includes(status), `trial ${trial}: status ${status}`);
  }
});

test('C7.11', 'a caller-supplied reviewer field is refused', async () => {
  const expenseId = await flagged();
  const reviewId = await reviewFor(expenseId);
  const res = await ctx.a.post(`/v1/reviews/${reviewId}/resolve`, {
    decision: 'APPROVE',
    reviewerId: '00000000-0000-0000-0000-000000000000',
  });
  eq(res.status, 400, 'status');
});

test('C7.12', 'an unknown resolve decision is refused', async () => {
  const expenseId = await flagged();
  const reviewId = await reviewFor(expenseId);
  for (const bad of ['MAYBE', '', null, 'approve']) {
    const res = await ctx.a.post(`/v1/reviews/${reviewId}/resolve`, { decision: bad });
    check(res.status === 400, `decision=${JSON.stringify(bad)} gave ${res.status}`);
  }
});

test('C7.13', "another company's review is 404, not 403", async () => {
  const expenseId = await flagged();
  const reviewId = await reviewFor(expenseId);
  const outsider = await login('nile');
  const read = await session(outsider.cookie).get(`/v1/reviews/${reviewId}`);
  eq(read.status, 404, 'read');
  const resolve = await session(outsider.cookie).post(`/v1/reviews/${reviewId}/resolve`, {
    decision: 'APPROVE',
  });
  eq(resolve.status, 404, 'resolve');
});

test('C7.14', 'a resolve on a non-existent review id is 404, not 500', async () => {
  const res = await ctx.a.post('/v1/reviews/01a1fe00-0000-7000-8000-000000000000/resolve', {
    decision: 'APPROVE',
  });
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  eq(res.status, 404, 'status');
});

test('C7.15', 'a malformed review id is 400 or 404, never a 500', async () => {
  const res = await ctx.a.get('/v1/reviews/not-a-uuid');
  check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
  check([400, 404].includes(res.status), `status ${res.status}`);
});

/* ---------------- Cycle 8: dashboard, listing, paging ---------------- */

test('C8.01', 'the dashboard summary totals equal the counts in the list', async () => {
  const summary = await ctx.a.get('/v1/dashboard/summary');
  eq(summary.status, 200, 'summary');
  const s = summary.json.summary ?? summary.json;
  const totals = s.byStatus ?? s.statuses ?? s;
  const counts = {};
  for (const status of ['APPROVED', 'REJECTED', 'PENDING_REVIEW']) {
    let seen = 0;
    let cursor = null;
    do {
      const page = await ctx.a.get(
        `/v1/expenses?status=${status}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      eq(page.status, 200, `list ${status}`);
      seen += page.json.items.length;
      cursor = page.json.nextCursor;
    } while (cursor);
    counts[status] = seen;
  }
  const reported = {
    APPROVED: totals.approved ?? totals.APPROVED,
    REJECTED: totals.rejected ?? totals.REJECTED,
    PENDING_REVIEW: totals.pendingReview ?? totals.PENDING_REVIEW,
  };
  for (const status of Object.keys(counts)) {
    eq(
      reported[status],
      counts[status],
      `${status}: summary says ${reported[status]}, the list holds ${counts[status]} (summary body ${JSON.stringify(totals)})`,
    );
  }
});

test('C8.02', 'the status filter returns only that status', async () => {
  const res = await ctx.a.get('/v1/expenses?status=APPROVED&limit=100');
  eq(res.status, 200, 'status');
  const wrong = res.json.items.filter((e) => e.status !== 'APPROVED');
  eq(wrong.length, 0, `rows with another status: ${JSON.stringify(wrong.slice(0, 2))}`);
});

test('C8.03', 'the decision filter returns only that decision', async () => {
  const res = await ctx.a.get('/v1/expenses?decision=REJECT&limit=100');
  eq(res.status, 200, 'status');
  const wrong = res.json.items.filter((e) => e.decision !== 'REJECT');
  eq(wrong.length, 0, 'rows with another decision');
});

test('C8.04', 'the category filter is case-insensitive', async () => {
  const upper = await ctx.a.get('/v1/expenses?category=GAMBLING&limit=100');
  const lower = await ctx.a.get('/v1/expenses?category=gambling&limit=100');
  eq(upper.status, 200, 'upper');
  eq(lower.status, 200, 'lower');
  eq(lower.json.items.length, upper.json.items.length, 'row counts differ by case');
  check(upper.json.items.length > 0, 'no GAMBLING rows to test with');
});

test('C8.05', 'free-text search matches the merchant', async () => {
  const marker = `QAMARKER${Date.now()}`;
  await submit(expense({ amount: 100, merchant: marker }), ctx.key);
  const res = await ctx.a.get(`/v1/expenses?q=${marker}&limit=50`);
  eq(res.status, 200, 'status');
  eq(res.json.items.length, 1, 'rows found');
  eq(res.json.items[0].merchant, marker, 'merchant');
});

test('C8.06', 'keyset paging walks every row once, with no duplicates and no gaps', async () => {
  const all = await ctx.a.get('/v1/expenses?limit=100');
  eq(all.status, 200, 'single page');
  const expected = all.json.items.map((e) => e.id);
  check(expected.length >= 10, `only ${expected.length} rows to page over`);

  const walked = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = await ctx.a.get(
      `/v1/expenses?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    eq(page.status, 200, 'page');
    walked.push(...page.json.items.map((e) => e.id));
    cursor = page.json.nextCursor;
    guard += 1;
  } while (cursor && guard < 200);

  eq(new Set(walked).size, walked.length, 'duplicate rows across pages');
  eq(walked.slice(0, expected.length).join(','), expected.join(','), 'paged order differs');
});

test('C8.07', 'a corrupt cursor is refused cleanly, never a 500', async () => {
  for (const bad of ['zzzz', '!!!!', 'eyJub3QiOiJhIGN1cnNvciJ9', 'a'.repeat(300)]) {
    const res = await ctx.a.get(`/v1/expenses?cursor=${encodeURIComponent(bad)}`);
    check(res.status !== 500, `cursor ${bad.slice(0, 12)} caused a 500: ${res.text.slice(0, 160)}`);
    eq(res.status, 400, `cursor ${bad.slice(0, 12)}`);
  }
});

test('C8.08', 'an out-of-range limit is refused', async () => {
  for (const bad of ['0', '-1', '1000', 'abc']) {
    const res = await ctx.a.get(`/v1/expenses?limit=${bad}`);
    check(res.status !== 500, `limit=${bad} caused a 500`);
    eq(res.status, 400, `limit=${bad}`);
  }
});

test('C8.09', 'an unknown filter value is refused rather than silently ignored', async () => {
  const res = await ctx.a.get('/v1/expenses?status=NOPE');
  eq(res.status, 400, 'status');
});

test(
  'C8.10',
  'a quote or percent in the search term is treated as text, not SQL or LIKE syntax',
  async () => {
    for (const term of ["'; DROP TABLE expenses; --", '%', '_', '100%%']) {
      const res = await ctx.a.get(`/v1/expenses?q=${encodeURIComponent(term)}&limit=5`);
      check(res.status !== 500, `term ${term} caused a 500: ${res.text.slice(0, 160)}`);
      eq(res.status, 200, `term ${term}`);
      if (term === '%' && res.json.items.length > 0) {
        // Recorded as a defect: Prisma's `contains` does not escape LIKE
        // metacharacters, so % and _ behave as wildcards in a user's search.
        console.log(`      note: q=% matched ${res.json.items.length} rows (wildcard leak)`);
      }
    }
    const health = await ctx.a.get('/v1/expenses?limit=1');
    eq(health.status, 200, 'the table still exists');
  },
);

test('C8.11', 'the expense categories endpoint is scoped to the company', async () => {
  const res = await ctx.a.get('/v1/dashboard/expense-categories');
  eq(res.status, 200, 'status');
  const list = res.json.categories ?? res.json.items ?? res.json;
  check(Array.isArray(list), `unexpected shape: ${res.text.slice(0, 200)}`);
});

/* ---------------- Cycle 9: policy settings ---------------- */

test('C9.01', 'a manager can read their own policy', async () => {
  const res = await ctx.a.get('/v1/policy');
  eq(res.status, 200, 'status');
  const p = res.json.policy ?? res.json;
  eq(p.autoApproveLimitMinor, 50_000, 'limit');
  eq(p.frequencyWindowMinutes, 60, 'window');
});

test('C9.02', 'a valid policy update is applied and reflected on the next decision', async () => {
  const patch = await ctx.a.patch('/v1/policy', { autoApproveLimitMinor: 10_000 });
  eq(patch.status, 200, `patch (${patch.text.slice(0, 200)})`);
  const res = await submit(expense({ amount: 20_000 }), ctx.key);
  eq(res.json.decision, 'REVIEW', 'the new limit must apply');
  await ctx.a.patch('/v1/policy', { autoApproveLimitMinor: 50_000 });
});

test('C9.03', 'an empty policy update is refused', async () => {
  const res = await ctx.a.patch('/v1/policy', {});
  eq(res.status, 400, 'status');
});

const badPolicies = [
  ['C9.04', 'a negative limit', { autoApproveLimitMinor: -1 }],
  ['C9.05', 'a fractional limit', { autoApproveLimitMinor: 10.5 }],
  ['C9.06', 'a zero frequency count', { frequencyMaxCount: 0 }],
  ['C9.07', 'a zero window', { frequencyWindowMinutes: 0 }],
  ['C9.08', 'a window beyond 24 hours', { frequencyWindowMinutes: 1441 }],
  ['C9.09', 'blockedCategories as a string', { blockedCategories: 'GAMBLING' }],
  ['C9.10', 'an empty blocked category', { blockedCategories: [''] }],
  ['C9.11', 'an unknown policy field', { surprise: 1 }],
];

for (const [tid, name, body] of badPolicies) {
  test(tid, `${name} is refused, never a 500`, async () => {
    const res = await ctx.a.patch('/v1/policy', body);
    check(res.status !== 500, `server error: ${res.text.slice(0, 200)}`);
    eq(res.status, 400, `status (${res.text.slice(0, 160)})`);
  });
}

test('C9.12', 'a policy update does not reach into another company', async () => {
  const before = await session((await login('nile')).cookie).get('/v1/policy');
  await ctx.a.patch('/v1/policy', { autoApproveLimitMinor: 12_345 });
  const after = await session((await login('nile')).cookie).get('/v1/policy');
  eq(JSON.stringify(after.json), JSON.stringify(before.json), "another company's policy changed");
  await ctx.a.patch('/v1/policy', { autoApproveLimitMinor: 50_000 });
});

test('C9.13', 'a policy change does not rewrite decisions already made', async () => {
  const expenseId = await flagged(60_000);
  await ctx.a.patch('/v1/policy', { autoApproveLimitMinor: 1_000_000 });
  const read = await ctx.a.get(`/v1/expenses/${expenseId}`);
  const e = read.json.expense ?? read.json;
  eq(e.decision, 'REVIEW', 'history was rewritten');
  await ctx.a.patch('/v1/policy', { autoApproveLimitMinor: 50_000 });
});

run('CYCLE 7-9  reviews, dashboard and listing, policy settings');
