# Endpoint authorization matrix

Every route this API serves, who may call it, where its tenant comes from, and
what the other callers get instead. Built in F09 by reading the controllers
**and** the queries underneath them, then exercised against the running stack
with real seeded companies.

> **The rule this table exists to make checkable:** the company is resolved
> from the verified credential - an API key row or a session - and from
> nowhere else. No route reads a company from a request body, and the two
> routes that take a company id in the **path** are administrator routes where
> the id is a selector applied after the role has already been established.

---

## Caller types

| Caller | How it authenticates | `companyId` |
|---|---|---|
| Company backend | `x-api-key` header | from the matched `api_keys` row |
| Company manager | `limaz_session` cookie | from the user row |
| Platform administrator | `limaz_session` cookie | **`null` by construction** - `tenantScope()` throws for them |
| Anonymous | - | - |

`@Roles(...)` implies a **human** caller: an API key has no role, so one
decorator closes both doors. That is why an API key gets
`caller_type_not_allowed` rather than `insufficient_role`.

---

## The matrix

`M` manager · `A` platform admin · `K` company API key · `-` refused

| Method | Route | M | A | K | Anon | Tenant from | Evidence |
|---|---|:-:|:-:|:-:|:-:|---|---|
| GET | `/health` | ✅ | ✅ | ✅ | ✅ | - public by design | F00-T02 |
| POST | `/v1/auth/login` | ✅ | ✅ | ✅ | ✅ | - public by design | F02-T07 |
| GET | `/v1/auth/me` | ✅ | ✅ | ✅ | 401 | credential | F02-T01, T09 |
| POST | `/v1/auth/logout` | ✅ | ✅ | 403 | 401 | session | F09-E2E T25, T26 |
| POST | `/v1/expenses` | 403 | 403 | ✅ | 401 | **API key row** | F09-E2E T19, T21 |
| GET | `/v1/expenses` | ✅ | 403 | 403 | 401 | session | F09-E2E T12, T16 |
| GET | `/v1/expenses/:id` | ✅ | 403 | 403 | 401 | session + id in WHERE | F09-E2E T2 |
| GET | `/v1/reviews` | ✅ | 403 | 403 | 401 | session | F09-E2E T13, T17 |
| GET | `/v1/reviews/:id` | ✅ | 403 | 403 | 401 | session + id in WHERE | F09-E2E T3 |
| POST | `/v1/reviews/:id/resolve` | ✅ | 403 | 403 | 401 | session + id in WHERE | F09-E2E T4, T22 |
| GET | `/v1/policy` | ✅ | 403 | 403 | 401 | session | F09-E2E T5, T14 |
| PATCH | `/v1/policy` | ✅ | 403 | 403 | 401 | session | F09-E2E T18 |
| GET | `/v1/dashboard/summary` | ✅ | 403 | 403 | 401 | session | F09-E2E T15 |
| GET | `/v1/dashboard/expense-categories` | ✅ | 403 | 403 | 401 | session | F06-T05 |
| GET | `/v1/admin/companies` | 403 | ✅ | 403 | 401 | **none - cross-tenant by design** | F09-E2E T6, T11 |
| POST | `/v1/admin/companies` | 403 | ✅ | 403 | 401 | creates one | F09-E2E T7 |
| GET | `/v1/admin/companies/:id` | 403 | ✅ | 403 | 401 | **path selector** | F08-B11 |
| GET | `/v1/admin/companies/:id/api-keys` | 403 | ✅ | 403 | 401 | path selector | F08-B22 |
| POST | `/v1/admin/companies/:id/api-keys` | 403 | ✅ | 403 | 401 | path selector | F09-E2E T8 |
| POST | `/v1/admin/.../api-keys/:keyId/rotate` | 403 | ✅ | 403 | 401 | path selector **+ keyId** | F09-E2E T9, A11c |
| POST | `/v1/admin/.../api-keys/:keyId/revoke` | 403 | ✅ | 403 | 401 | path selector **+ keyId** | F09-E2E T10, A14 |
| GET | `/v1/admin/companies/:id/managers` | 403 | ✅ | 403 | 401 | path selector | F11-T17, T18, T19 |
| POST | `/v1/admin/companies/:id/managers` | 403 | ✅ | 403 | 401 | path selector; **role and company written by the server** | F11-T10, T11, T17 to T20 |
| GET | `/v1/admin/companies/:id/webhook-integration` | 403 | ✅ | 403 | 401 | path selector | F12-T04 |
| POST | `/v1/admin/companies/:id/webhook-integration` | 403 | ✅ | 403 | 401 | path selector; **returns a secret once**, `no-store` | F12-T01, T04 |
| GET | `/v1/admin/simulator` | 403 | ✅ | 403 | 401 | none - reports a deployment flag | F12-T150 |
| POST | `/v1/admin/simulator/payments` | 403 | ✅ | 403 | 401 | body `companyId`, **after** the role check; 404 when the sandbox is off | F12-T130 to T136, T151 |
| GET | `/v1/admin/webhook-events` | 403 | ✅ | 403 | 401 | none - cross-tenant by design, filterable | F12-T140, T142 |
| GET | `/v1/admin/webhook-events/:id` | 403 | ✅ | 403 | 401 | none - cross-tenant by design | F12-T142 |
| POST | `/v1/webhooks/card-transactions` | n/a | n/a | n/a | **signature** | **the integration whose secret verified** | F12-T10 to T26 |

Every ✅ above was executed against the running stack in the F09 end-to-end
cycle (79 checks, 0 failures) and, for the F11 and F12 rows, in their own
suites and in the F13 demonstration (49 checks, 0 failures). The refusals are
not inferred from decorators.

### What the `Anon` column assumes

**`401` assumes the caller sends `x-limaz-client`.** On a **state-changing**
method without it, `CsrfGuard` runs before authentication resolves and answers
first:

```
PATCH /v1/policy          (no credential, no x-limaz-client)
HTTP/1.1 403 Forbidden
{"statusCode":403,"error":"csrf_header_required", ...}
```

Send the header and the same request is `401`, as the column says.

The ordering is deliberate and is the better of the two: the CSRF check is a
property of the **request**, not of the caller, so it is settled before the
credential path is touched at all. A request that could never be honoured is
refused without a database lookup and without a bcrypt comparison.

**`GET` is unaffected** and answers `401` with or without the header, because
`CsrfGuard` only guards state-changing methods - a safe method cannot be the
thing CSRF protects against.

> Recorded in F13 after the QA regression pass raised it as MIN-05. The report
> stated the 403 applied to every route; it applies to the state-changing ones
> only, which is why the distinction is written out here rather than added as
> a one-line footnote.

### The one row that does not fit the columns

`POST /v1/webhooks/card-transactions` has no manager, admin or API-key
answer, because **none of those caller types applies to it**. The assessment
says the card provider cannot send our API key, and it has no session, so the
route is `@Public()` to the authentication guard and authenticates on an HMAC
signature instead:

| Caller | Answer |
|---|---|
| A correctly signed delivery, within the timestamp window | **202**, bound to the company whose secret verified |
| No signature, or a wrong, malformed or stale one | **401**, one shape for every cause |
| A signature made with another company's secret | **401** - a delivery id selects a secret, it proves nothing |
| A browser, cross-site, with a cookie attached | **401**. The cookie is never read, and the browser cannot produce a signature |

It is also the only route carrying `@WebhookExempt()`, which turns off
`CsrfGuard`. The justification is the one that already exempts API-key
callers: CSRF protects a credential the **browser attaches automatically**,
and this route reads none. The decorator is opt-in per route and must never
be placed on a route that reads the session cookie.

---

## Cross-tenant behaviour

A manager naming another company's real id gets **404, not 403** (ADR-003).
403 at row level confirms the row exists, which turns the endpoint into an
enumeration oracle.

| Attempt | Answer | Evidence |
|---|---|---|
| Company B reads A's expense by id | 404 | F09-E2E T2 |
| Company B reads A's review by id | 404 | F09-E2E T3 |
| Company B resolves A's review | 404, and A's review is untouched | F09-E2E T4 |
| Company B reads A's policy | B's own policy, never A's | F09-E2E T5 |
| A body carrying `companyId` | **400** - `.strict()` refuses the field | F09-E2E T21 |
| A body carrying `resolvedByUserId` | **400** - same | F09-E2E T22 |
| Admin names company A's id with company B's key id | refused, B's key unmutated | F08-B32, B38 |

The predicate is in the **query**, not in a branch after it:

```ts
prisma.expense.findFirst({ where: { id: expenseId, companyId } })
```

so "not yours" and "not there" are genuinely one code path. F06-NC1 is the
negative control: remove the tenant predicate and the whole table comes back
with nothing erroring.

### Nested relations

`Review(expenseId, companyId)` is a **composite foreign key** onto
`Expense(id, companyId)` (ADR-011), so a review whose company differs from its
expense's is physically unstorable. That is why the nested `review` include on
the expense detail carries no tenant predicate of its own - it cannot need
one. F01-T09 and T09b are the proof at the schema level.

---

## Frontend authorization

**Supplementary, never the boundary.** Every refusal above holds with the UI
bypassed entirely - that is how the table was measured.

What the frontend adds is that an unauthorized page does not *render*:

| Case | Behaviour | Evidence |
|---|---|---|
| Manager opens `/admin` | 403 explanation; admin page contributes nothing to the RSC payload | AI_LOG 44, re-verified F09 on the nested route |
| Administrator opens `/dashboard/*` | "Company workspace" explanation, no fetch attempted | AI_LOG 47 |
| Session expires mid-page | redirect to `/login?reason=expired` | F06-T36 |
| User switches | `QueryProvider` keyed by `user.id`, so there is no cache to read | F06-T37 |

The RSC payload was read directly for both directions in F09 and checked for
the other role's strings. A layout that hides its children does **not** stop
them rendering - that is AI_LOG 44, and it is why the check is on each page.
