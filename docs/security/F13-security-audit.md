# F13 - Final security audit

Everything the bonus added, re-read against the controls the core already had.
Each row says what was **checked**, not what was intended.

> **This does not claim zero risk.** It separates what is verified from what is
> accepted, and the accepted ones are in [`../risks.md`](../risks.md) with the
> cost of each.

---

## 1. Manager provisioning (F11)

| Question | Answer | Evidence |
|---|---|---|
| Can a caller set their own role? | No. `role` is written by the server and is absent from a `.strict()` schema, so a body claiming `PLATFORM_ADMIN` is a 400 that creates nothing | F11-T10 |
| Can a caller set the company? | No. Same mechanism; the company is the path parameter, after the role check | F11-T11, F11-T11b |
| Can a provisioned manager provision more? | No. The role check that refuses every manager refuses them too | F11-T16b |
| Is the password ever stored or returned in the clear? | No. bcrypt at rest, and the response carries no credential at all | F11-T12, F11-T13 |
| Does the browser retain it? | No. Cleared from component state on success and on close; verified in the browser with both storages empty and the value absent from the DOM | browser-verified |
| Is a long passphrase silently truncated? | No. Refused at 72 **bytes**, because that is what bcrypt hashes | F11-T08b |
| Can a duplicate email race through? | No. The unique index is the authority; two concurrent creations give `[201, 409]` and one row | F11-T06d |

**Accepted:** there is no way to change or reset a manager's password (R-36).

---

## 2. Webhook authentication (F12)

| Question | Answer | Evidence |
|---|---|---|
| Is the signature checked over the bytes as received? | Yes. `rawBody: true`; a re-serialised body with different whitespace is refused | F12-T19 |
| Is a modified body caught? | Yes, even when the signature was valid for the original | F12-T18 |
| Is the comparison constant-time? | Yes, after a shape check - `timingSafeEqual` throws on a length mismatch, which would itself be an oracle | F12-U44 |
| Are malformed signatures refused rather than crashing? | Yes: wrong length, wrong encoding, uppercase hex, empty | F12-T14, T15, T16 |
| Can another company's secret sign for this one? | No | F12-T17 |
| Is replay bounded in both directions? | Yes. Stale and far-future timestamps are both refused | F12-T20, T21, T22 |
| Does a malformed timestamp slip through? | No. A regex before `Number`, because `parseInt` accepts `1763000000abc` | F12-T23 |
| Does an unknown delivery id leak through timing? | No. The HMAC runs against a dummy secret either way | by construction; same pattern as `PasswordService.dummyHash` |
| Is anything stored for a refused delivery? | No | F12-T25 |
| Is the body parsed before authentication? | No. Nothing attacker-controlled is parsed until the sender is known to be genuine | by construction, `accept()` |

---

## 3. Secret storage and exposure

| Question | Answer | Evidence |
|---|---|---|
| Is the signing secret in plaintext anywhere? | No. AES-256-GCM; the column holds no part of it | F12-T03 |
| Can a dump alone be used? | No. The key is in `WEBHOOK_ENCRYPTION_KEY`, never in the database | by construction |
| Is a secret moved between companies usable? | No. The company id is the AAD, so it fails to decrypt | F12-U13 |
| Does any GET return a secret, a ciphertext, an IV or a tag? | No | F12-T02 |
| Does the provisioning response say `no-store`? | Yes - the only F12 response carrying a credential | F12-T01 |
| Does the simulator return a secret? | No | F12-T103 |
| Does the event history return a payload or a signature? | No. The shape is built field by field on the server | F12-T141 |
| Does the browser ever hold a signing secret? | No. Signing is in-process | by construction |
| Does the process start without a key? | No. Required in every environment, with no default | `env.spec.ts` |

**Accepted:** the key lives in process configuration rather than a KMS (R-35).

---

## 4. Tenant isolation, re-verified on the new paths

| Question | Answer | Evidence |
|---|---|---|
| Where does a webhook's company come from? | The integration whose secret verified the signature | F12-T40 |
| Can the body name a company? | There is no such field. Inside `data` it is a 400; on the envelope it is ignored and the event still lands in the authenticated company | F12-T41 |
| Are two companies' events independent? | Yes, including identical provider event ids | F12-T42 |
| Does a webhook expense stay in its company? | Yes. The other company's manager gets **404**, not 403 | F12-T90 |
| Can a manager read the event history? | No | F12-T142 |
| Can an ordinary API caller collide with a webhook expense? | No. Separate namespaces, and the API caller still cannot duplicate its own identifier | F12-T91, F12-T92 |

---

## 5. The simulator

| Question | Answer | Evidence |
|---|---|---|
| Can it be aimed at another host? | No. The destination is built from configuration; `.strict()` refuses `url`, `destination`, `endpoint`, `target`, `webhookUrl` | F12-T134 |
| Does a disabled sandbox still answer? | No. 404 to a genuine administrator calling the API directly | F12-T151 |
| Is the flag derived from `NODE_ENV`? | No, deliberately - the image sets `NODE_ENV=production` on a laptop | by construction |
| Do the failure presets disable anything? | No. They send genuinely wrong signatures and genuinely stale timestamps to the real verifier | F12-T110, T111 |
| Can a manager or an API key use it? | No: 403 `insufficient_role` and 403 `caller_type_not_allowed` | F12-T130, T131 |
| Does CSRF still apply? | Yes - it is a cookie-authenticated admin route | F12-T133 |
| Does turning the sandbox off disable the real endpoint? | No. The integration a real provider uses is unaffected | F12-T152 |
| Is any card data requested? | No. The provider's contract has none, so neither does this | by construction |

---

## 6. Error handling and what reaches a caller

| Question | Answer | Evidence |
|---|---|---|
| Does an oversized body still 500? | **No - fixed.** It was a 500 on every endpoint since F03; body-parser's rejection carries a 413 but is not an `HttpException`, so the filter's catch-all flattened it | F12-T55, AI_LOG 58 |
| Does the limit appear in the message? | No. The message is written here, not copied from the library | F12-T55 |
| Is `lastError` safe to render? | Yes. Sanitised where written - the API's own message, never a stack trace or a query | F12-T80 |
| Is the 400 vocabulary consistent? | Yes. An error code is kept only if it is `lower_snake_case`, so Nest's reason phrases cannot leak into a contract that uses snake_case everywhere | F12-T30 |

---

## 7. The CSRF exemption

The one genuinely new hole-shaped thing in F12, so it gets its own section.

`@WebhookExempt()` turns off `CsrfGuard` for a route. It is justified by the
same reasoning that exempts API-key callers: CSRF protects a credential the
**browser attaches automatically**, and this route reads no cookie and no
ambient credential. A cross-site page that makes a browser POST there achieves
nothing, because the browser has no signing secret.

What makes it safe to keep:

- it is **opt-in per route**, never a path pattern
- there is **exactly one** route carrying it
- that route is also `@Public()`, so it has no session to protect in the first
  place
- the decorator's own comment states the rule it must never break: *it must
  never be placed on a route that reads the session cookie*

---

## 8. Git and screenshot hygiene

| Check | Result |
|---|---|
| `.env` tracked? | No - gitignored, confirmed with `git check-ignore` |
| `.agents/`, `.claude/`, `skills-lock.json` tracked? | No - all three confirmed ignored |
| Structural secret scan of the F11 and F12 diffs | One match: the **timing-floor dummy secret**, a literal placeholder that is not a credential and exists so an unknown delivery id still costs an HMAC |
| Encryption keys in the repository | Two, both deliberate and labelled in place: a development key in `docker-compose.yml` so one `docker compose up` still works on a fresh clone, and a fixed test key in the harnesses |
| Screenshots | The F11 and F12 browser captures were written to `.playwright-mcp/`, which is gitignored, and none is committed |

---

## 9. Response headers, after the QA regression pass

Added in F13 after an independent black-box pass found two hygiene gaps that
**were not in the risk register at all** - which is the part worth admitting.
This repository argues that its limitations are named rather than hidden, and
a gap nobody wrote down is not an accepted trade-off.

| Header | Where | What it is for | What it is NOT |
|---|---|---|---|
| `Content-Security-Policy: frame-ancestors 'none'` | web | The dashboard cannot be framed, so its one-click approve and reject controls cannot be clickjacked (R-39) | **Not a Content-Security-Policy.** One directive. It governs who may frame the page, not what may execute inside it. R-18 is untouched |
| `X-Frame-Options: DENY` | web | The same thing, for browsers that read only this | Redundant on purpose. They agree, because the application is never framed by anything |
| `X-Content-Type-Options: nosniff` | web | A response is not sniffed into a type it was not sent as | |
| `Referrer-Policy: strict-origin-when-cross-origin` | web | Expense, review and company ids travel in paths. Without it a full URL carrying one goes to any third-party origin as a `Referer` | |
| No `X-Powered-By` | **both** | It named the framework whose CVE list to start from, on every response, to unauthenticated callers too (R-40) | **Hygiene, not defence.** The stack is still fingerprintable from error shapes and header ordering. Removed because it gave something away for nothing, not because it stops anybody |

**Why clickjacking was the one that mattered.** The session cookie is
`SameSite=Lax`. That blocks a cross-site POST, but **not a framed top-level
GET** - the frame loads fully authenticated. R-18 accepted the absence of a
CSP and said nothing about framing, so the gap sat between two entries.

**Verified by response, not by suite.** These headers come from the Next.js
server and the Express adapter, not from application code a Jest suite can
reach, so `scripts/check-security-headers.sh` checks them against a running
build - **6 of 6 passing** after a rebuild. It needs a rebuilt stack, so it is
step 5 of the verification order rather than part of `npm test`.

## 10. What is NOT claimed

- **No rate limiting** on the webhook endpoint. A valid signature is required,
  so an attacker cannot force work beyond a signature check - but a company
  whose secret leaked could flood its own inbox. R-19 covers the login case;
  this is the same gap on a different door.
- **No audit log** of administrative actions, including provisioning a manager
  or replacing a signing secret. `createdAt`, `rotatedAt` and `secretVersion`
  make the *fact* recoverable; who did it is not recorded.
- **No reconciliation** against the provider, so an event that never arrived
  leaves no trace (R-38).
- **No penetration test**, no dependency upgrade for the 22 `npm audit`
  findings analysed as unreachable (R-30), and no WCAG conformance claim.
- **No Jest assertion on the response headers above.** The check script is a
  separate step that needs a rebuilt stack, so a future change to
  `next.config.ts` could remove them and `npm test` would stay green.
- **An independent pass found gaps this audit had not.** The QA regression
  cycle of 21 November 2026 found no functional defect, but it did find two
  hardening items that were absent from both this document and the risk
  register, and one limitation (R-11) described too narrowly since F04. That
  is evidence about how far a self-audit reaches, and it is the reason this
  section exists at all.
