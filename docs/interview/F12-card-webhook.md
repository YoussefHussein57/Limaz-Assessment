# F12 / F13 - Interview defence

Ten questions a LIMAZ interviewer could reasonably ask after reading the
webhook bonus.

قبل كل سؤال فيه سطر **بالعربي** بيقول المُحاوِر عايز يوصل لإيه منه.

---

## Q1 - Why a webhook is not just another API call

> You already have an authenticated `POST /v1/expenses`. Why did the webhook
> need a different authentication mechanism at all?

**بالعربي:** بيختبر إنك فاهم إن الفرق مش في الـ HTTP، الفرق في **مين بيبدأ
الاتصال ومين بيملك الـ credential**. لو جاوبت "عشان كده الـ spec قال كده"
يبقى محفوظ مش مفهوم.

**Because the direction of trust is reversed, and the assessment says so in
one line: *"It cannot send your API key."***

An ordinary submission is a company's own backend calling us. It holds a
credential we issued, it sends it deliberately, and it retries when it decides
to.

A webhook is a **third party we did not issue a credential to**, calling us
about an event we did not ask for, on a schedule we do not control. Three
consequences follow, and each one is a design constraint rather than a
preference:

| | |
|---|---|
| **No key to present** | So authentication has to be something the provider can compute per request: a MAC over the body, with a secret **they** were configured with |
| **It retries until it gets a 2xx** | So a 2xx is a promise. Answering before the event is durable breaks it on the first restart |
| **It is the one caller with no ambient credential** | So CSRF protection is meaningless here, and the route is exempt - for the same reason API-key callers are |

The shape of the endpoint falls out of those: `@Public()`, `@WebhookExempt()`,
and a verifier that refuses before the body is even parsed.

---

## Q2 - Why HMAC needs the raw request body

> You set `rawBody: true` globally for one route. What breaks if you verify
> the parsed object instead?

**بالعربي:** ده أكتر سؤال بيفرق بين حد عمل webhook فعلاً وحد قرأ عنه.
المطلوب: تعرف إن `JSON.parse` بعدين `JSON.stringify` **مش** نفس البايتات،
وتعرف إن النتيجة مش بس أخطاء متقطعة - دي ثغرة أمنية.

**Two things break, and the second is the serious one.**

`JSON.parse` followed by `JSON.stringify` is not the identity function. It
normalises whitespace, drops insignificant formatting, re-encodes unicode
escapes and renders `1.0` as `1`. An HMAC is over bytes.

1. **It fails intermittently.** Every pretty-printed delivery, every provider
   that happens to order or space its JSON differently, fails signature
   verification - and the failure looks like the provider's fault.

2. **It can be made to verify a body that differs from the one you act on.**
   You verify a *re-serialisation* and then hand the *parsed object* to your
   business logic. Anywhere those two can diverge - duplicate keys, where
   parsers disagree about which wins, number precision, unicode normalisation -
   an attacker has a gap between what was authenticated and what was executed.

F12-T19 pins it: the identical object, delivered with
`JSON.stringify(event, null, 2)`, is refused.

**The separator matters too.** `${timestamp}.${rawBody}`, not concatenation:
without the dot, timestamp `1` with body `23{...}` and timestamp `12` with
body `3{...}` sign the same string (F12-U31).

---

## Q3 - Why this secret is encrypted when every other one is hashed

> ADR-006 argues hard for storing only hashes. You then stored a webhook
> secret reversibly. Defend the inconsistency.

**بالعربي:** بيتأكد إنك بتفهم **ليه** الـ hashing بينفع، مش بتطبقه كـ قاعدة
عمياء. ولو جاوبت صح، بيشوف هل هتعترف إن ده أضعف ولا هتحاول تبيعه كأنه نفس
الأمان.

**It is not an inconsistency - hashing solves a problem that does not exist
here.**

Hashing works for an API key because the server is **handed the credential**
and only has to decide whether it matches. A one-way function is sufficient.

HMAC verification is a different problem. The provider never sends the secret;
it sends a MAC computed **with** the secret, and checking it means computing
the same MAC. That needs the key material. There is no digest that can stand
in: HMAC keyed with `sha256(secret)` is a different function and would never
match what the provider sent.

So the secret has to be recoverable, and the real question is *by whom*:

| | |
|---|---|
| Plaintext column | A database dump is a set of working signing keys |
| **Encrypted, key in configuration** | **Chosen.** A dump is inert; an attacker needs the database **and** the environment |
| External KMS or HSM | The correct production answer, where the key never enters the process. An entire subsystem the assessment does not ask for |

**I will say plainly that this is weaker than hashing**, which is why it is
R-35 rather than a footnote.

Two details I would point at: **GCM, not CBC**, because it is authenticated -
a tampered row throws rather than yielding a different key that would then
fail HMAC and look like the provider's fault. And the **company id is the
additional authenticated data**, so a ciphertext copied into another company's
row fails to decrypt (F12-U13) - which is the injection somebody with write
access would actually try.

---

## Q4 - Timestamp validation and replay protection

> Why is there a timestamp in the signature at all, and why do you reject
> future-dated ones?

**بالعربي:** بيشوف هل فاهم إن الـ signature لوحدها **مش** بتمنع الـ replay،
وهل مميّز بين وقت التوقيع ووقت الدفع - ودي أكتر حتة الناس بتخلط فيها.

**Without it, a captured request is replayable forever.** The signature is
valid for those exact bytes, and those bytes do not expire on their own. Put
the timestamp **inside** the signed material and it cannot be moved forward
without invalidating the MAC - so a captured request is only replayable for
the length of the window.

**The future bound is not symmetry for its own sake.** A past-only check does
nothing about a request signed with a timestamp years ahead: it would sit
valid until that date arrives. Both directions, or neither is worth much
(F12-T21).

**And it bounds the delivery, not the payment.** This is the part worth
getting right out loud - there are three timestamps and they are not the same
thing:

| | What it is | What bounds it |
|---|---|---|
| **Signature timestamp** | When this HTTP request was signed | 300 seconds. Replay protection |
| **`spentAt`** | When the money was spent | 90 days back, 5 minutes forward. Also the frequency window |
| **Processing time** | When a worker evaluated it | Recorded, never used to decide |

A payment from last Tuesday, redelivered this morning after a provider outage,
is **legitimate**: an old transaction with a fresh signature. Rejecting it
because `spentAt` is old would drop real expenses.

---

## Q5 - Event identity versus expense idempotency

> You have two unique constraints that both look like deduplication. Is one
> redundant?

**بالعربي:** بيختبر هل فاهم إن فيه **طبقتين** مختلفتين: تكرار التسليم من
المزوّد، وتكرار المصروف نفسه. اللي يقول واحدة تكفي يبقى مش شايف إن الحدث
والمعاملة حاجتين مختلفتين.

**No. They protect different boundaries, and neither subsumes the other.**

```
DELIVERY deduplication   unique (companyId, providerEventId)
  the provider retried. Do not process the same event twice

EXPENSE idempotency      unique (companyId, source, externalId)
  two different events describe one payment. Do not create two expenses
```

An event id identifies a **delivery**; a transaction id identifies a
**payment**. The assessment's guarantee is about transactions, so the
expense's `externalId` is `data.transactionId`.

Drop the first and a redelivery is processed again - the expense layer would
still save you, but the attempt counter, the logs and the event history would
all be wrong. Drop the second and two legitimately different events about one
payment create two expenses, which is the actual guarantee failing.

**The payload hash deliberately excludes delivery metadata** - `createdAt`,
the signature timestamp, the signature. A legitimate replay is signed afresh,
so those change while the payment has not. Fold them in and every retry looks
like a conflict, and the provider could never successfully redeliver anything.
That was a real bug in the simulator's replay preset (AI_LOG 56).

**And why `source` is in the expense key:** a provider's `transactionId` is
chosen by somebody the company's backend has never spoken to. A reserved
prefix cannot keep them apart, because an ordinary client picks the *whole*
`externalId` itself and could choose one that looks like a transaction id. For
an API caller the key is unchanged, so nothing is weakened (F12-T92).

---

## Q6 - Durable acknowledgment

> You answer 202. What exactly are you promising, and when do you send it?

**بالعربي:** بيشوف هل فاهم إن الـ 2xx **عقد** مع المزوّد، مش مجرد رد. ولو
بعته قبل الـ commit تبقى كدبت عليه.

**After the commit, never before. And 202, not 201.**

The provider retries until it gets a 2xx, which means a 2xx is the moment it
**stops**. So it is a promise: *this event will be processed*. Send it before
the row is committed and the first restart breaks that promise - the provider
has moved on, and the event exists nowhere.

202 rather than 201 because the event is stored and **no expense exists yet**.
"Created" would be a lie told by a status code, and a provider dashboard
showing it for an event that policy will REJECT is worse than no status.

The response body repeats it in words, because "accepted" and "approved" are
one letter apart and mean opposite things here.

**This is also why the expense is not created inline.** Acceptance would then
depend on how long a policy evaluation takes, and a provider that times out
retries - which is how one payment becomes several attempts at one expense.
Accept fast, process after.

---

## Q7 - Worker concurrency

> Two workers, one inbox. Why can they not claim the same event?

**بالعربي:** ده نفس درس F04 بس في سياق تاني. بيشوف هل بتقرأ-وبعدين-تكتب ولا
بتخلي الـ database هي اللي تقرر، وهل تعرف `SKIP LOCKED` ليه موجودة أصلاً.

**Because the lock and the state change are one statement.**

```sql
UPDATE webhook_events SET status = 'PROCESSING', "claimedAt" = now(), attempts = attempts + 1
WHERE id = (SELECT id FROM webhook_events WHERE ... FOR UPDATE SKIP LOCKED LIMIT 1)
```

`FOR UPDATE` locks the row the sub-select found; the surrounding `UPDATE`
changes it in the same statement; and a competitor's `SKIP LOCKED` **steps
over** the locked row rather than waiting for it. Both workers make progress
and neither gets the same event.

Without `SKIP LOCKED` they would queue behind each other and the queue would
be serial. With a plain SELECT then UPDATE it is the F04 read-then-write race:
both read the same PENDING row, both update it, and the event is processed
twice.

**Why not the advisory lock F04 uses?** F04's invariant is a COUNT across many
rows, which needs serialising. This invariant is one row changing state, and
claiming is exactly the operation that should be parallel - an advisory lock
would funnel every worker through one gate for no gain.

**One more detail worth volunteering:** `attempts` is incremented **at claim
time**, not on completion. An event that crashes the worker every time still
advances towards its bound; counting on completion would retry it forever.

---

## Q8 - Crash recovery after the expense commits

> A worker commits the expense, then the process is killed before it marks the
> event processed. What is the state of the world, and what happens next?

**بالعربي:** ده السؤال اللي بيكشف هل عملت الـ failure window ده فعلاً ولا بس
كتبت عنه. لازم تعرف الترتيب بالظبط، وتعرف إن الإصلاح جاي من الـ idempotency
اللي موجودة أصلاً مش من كود جديد.

**One expense exists, and one event row says nothing about it. That is the
whole window, and it is recoverable because of machinery that already
existed.**

In order:

1. the worker claims the event: `PROCESSING`, `claimedAt = now()`
2. `submit()` commits - the expense, its rule hits, its review
3. the process dies
4. the lease expires
5. the next attempt's claim query matches rows still `PROCESSING` whose
   `claimedAt` is older than the lease, and takes it - `attempts` is now 2
6. `submit()` runs again, finds the existing expense by
   `(companyId, source, externalId)`, and returns it with `duplicate: true` -
   **the original decision**, no second rule hit, no second review, nothing
   added to a future frequency window
7. the event is marked `PROCESSED` with that expense's id

**No new code was needed for step 6.** It is ADR-001's idempotency, which the
core already had and already tested. That is the argument for calling the same
`ExpenseSubmissionService` rather than writing a webhook-specific path: the
recovery story comes free, and correct.

F12-T71 does exactly this, including backdating `claimedAt` so the lease is
genuinely expired rather than slept through.

---

## Q9 - At-least-once, and what you refuse to claim

> Is this exactly-once?

**بالعربي:** فخ. الإجابة الصح إنك ترفض الادعاء وتقول بالظبط إنت بتضمن إيه.
اللي بيقول "أيوه exactly-once" بيكشف نفسه.

**No, and nothing in the repository says it is.**

Exactly-once *delivery* over a network does not exist. The provider cannot
know whether a dropped response means we received the event, so it retries;
that is correct behaviour and the reason the inbox has a unique constraint.

What is claimed is narrower and true: **at-least-once processing with
idempotent business effects.** An event may be processed more than once - a
crash, a lease expiry, a redelivery - and the effect happens once:

- one expense per transaction
- one review, if the decision was REVIEW
- one contribution to a frequency window
- the original decision, never recomputed

The honest framing is that correctness lives in the **effects**, not in the
delivery count, and the database constraints are what make that true rather
than careful code.

I would also say what is *not* guaranteed: **ordering**. Two events for one
employee can be processed in either order, and the frequency rule evaluates
forward-only, so the same pair can produce different decisions depending on
arrival order - which is the existing accepted limitation R-11, not a new one.

---

## Q10 - Simulator security, and why it proves anything

> You built a tool that forges correctly signed provider requests. Convince me
> that is safe, and that the demonstration means something.

**بالعربي:** جزئين. الأول أمني: أداة بتوقّع requests لازم يبقى فيه سبب إنها
مش موجودة في production. التاني منهجي: demo بيقيس نفسه مش demo.

**On safety, three independent properties:**

| | |
|---|---|
| **It does not exist unless a flag says so** | `SANDBOX_SIMULATOR_ENABLED`, checked **in the service**, so a disabled deployment answers 404 to a direct API call - not a hidden navigation link. Explicitly **not** `NODE_ENV`, which this image sets to `production` on a laptop; that signal lied once already (AI_LOG 42) |
| **There is no destination parameter** | The target is built from `API_PORT` and a constant path on the loopback interface. A caller-supplied URL would make this an authenticated SSRF primitive aimed at anything the container can reach. The feature gains nothing from being configurable |
| **The secret never reaches the browser** | Signing happens in-process. The page could not produce a valid signature if it tried |

**On whether the demonstration means anything - this is the part I would
defend hardest.** It would have been much easier to build a simulator that
called `ExpenseSubmissionService` directly and showed the result. That tool
would pass while the real integration was broken.

So: it builds a real body, signs it with the company's real secret, and sends
a real HTTP request to the real endpoint, which runs the real verifier. The UI
shows only what the server wrote - the HTTP status, the event's `status`
column, the expense's decision. Nothing on that page is computed in the
browser and nothing advances on a timer.

**The failure presets are the proof.** `INVALID_SIGNATURE` signs with a key
the server does not hold. `EXPIRED_SIGNATURE` signs correctly for a stale
timestamp. Both are refused with 401 by the same code path a real provider
faces. If I had weakened verification anywhere, those two presets would start
succeeding.

**And the one weakness I would raise before you do:** the simulator shares a
process with the API, so it is not a true external client. That is exactly why
`scripts/send-card-webhook.mjs` exists - an independent signer, written
against the documented contract using Node's standard library. If the README
is wrong about the protocol, that script fails. The same reasoning is why the
test client computes the HMAC itself rather than importing `computeSignature`:
if both sides came from one function, a mistake in it would be symmetric and
invisible.
