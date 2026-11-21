# F11 and F12 - test matrix

**Generated from the Jest report, never typed by hand.** Every row is a case
that ran, with the status the runner gave it. Regenerate with:

```bash
npm test --workspace @limaz/api -- --json --outputFile=report.json
node scripts/make-test-matrix.mjs report.json
```

The hand-written matrices for F00-F09 record what I believed. This one
records what happened - which matters, because one hand-written matrix was
wrong for six features (AI_LOG 45).

## F11 - manager provisioning

`manager-provisioning.e2e-spec.ts` — real PostgreSQL, real HTTP, the review lifecycle wired in

| Case | What it asserts | Result |
|---|---|---|
| F11-T01 | a brand new company starts with no managers | **PASS** |
| F11-T02 | the administrator creates a manager | **PASS** |
| F11-T03 | the new account appears in the listing | **PASS** |
| F11-T04 | an unknown company is 404, not a foreign-key 500 | **PASS** |
| F11-T04b | a malformed company id is 400 | **PASS** |
| F11-T05 | an empty display name is refused | **PASS** |
| F11-T06 | a malformed email is refused | **PASS** |
| F11-T06b | a duplicate email is a 409, from the database | **PASS** |
| F11-T06c | the email is unique GLOBALLY, not per company | **PASS** |
| F11-T06d | two simultaneous creations of the same email produce exactly one account | **PASS** |
| F11-T07 | the email is normalised the same way login normalises it | **PASS** |
| F11-T08 | a short password is refused | **PASS** |
| F11-T08b | a password beyond bcrypt’s 72 bytes is refused, not truncated | **PASS** |
| F11-T09 | an unknown property is refused rather than ignored | **PASS** |
| F11-T10 | a body claiming PLATFORM_ADMIN is refused, and creates nothing | **PASS** |
| F11-T11 | a body claiming another companyId is refused, and creates nothing | **PASS** |
| F11-T11b | the company comes from the PATH, whatever the body said | **PASS** |
| F11-T12 | the password is stored as a bcrypt hash, never in plaintext | **PASS** |
| F11-T13 | no response ever carries a password or a hash | **PASS** |
| F11-T14 | the new account authenticates and lands in the right company | **PASS** |
| F11-T14b | the wrong password still fails for a provisioned account | **PASS** |
| F11-T15 | a company can have several managers | **PASS** |
| F11-T16 | a provisioned manager cannot reach another company’s data | **PASS** |
| F11-T16b | a provisioned manager cannot reach platform administration | **PASS** |
| F11-T17 | a seeded company manager is refused both routes | **PASS** |
| F11-T18 | a company API key is refused for its KIND | **PASS** |
| F11-T19 | an unauthenticated caller is refused | **PASS** |
| F11-T20 | CSRF protection still applies to manager creation | **PASS** |
| F11-T21 | the company detail reflects the new managers | **PASS** |
| F11-T22 | a provisioned manager resolves a review and is recorded as the reviewer | **PASS** |

## F12 - cryptographic primitives

`webhook-crypto.spec.ts` — unit, no database. The HMAC is checked against an independent implementation

| Case | What it asserts | Result |
|---|---|---|
| F12-U01 | accepts exactly 32 bytes | **PASS** |
| F12-U02 | refuses a key of the wrong length | **PASS** |
| F12-U03 | never puts the value in the error | **PASS** |
| F12-U10 | a sealed secret round-trips | **PASS** |
| F12-U11 | the ciphertext contains no part of the plaintext | **PASS** |
| F12-U12 | sealing the same secret twice gives different ciphertext | **PASS** |
| F12-U13 | a secret moved to another company fails to decrypt | **PASS** |
| F12-U14 | a tampered ciphertext fails rather than decrypting to something else | **PASS** |
| F12-U15 | the wrong encryption key fails to decrypt | **PASS** |
| F12-U20 | a signing secret is 256 bits, prefixed | **PASS** |
| F12-U21 | secrets and delivery ids do not repeat | **PASS** |
| F12-U30 | is the timestamp, a dot, and the raw bytes | **PASS** |
| F12-U31 | the separator prevents a boundary collision | **PASS** |
| F12-U32 | byte-identical bodies with different formatting differ | **PASS** |
| F12-U40 | agrees with an independent HMAC implementation | **PASS** |
| F12-U41 | is 64 lowercase hex characters | **PASS** |
| F12-U42 | changes when any input changes | **PASS** |
| F12-U43 | matches itself and nothing else | **PASS** |
| F12-U44 | rejects a malformed signature without throwing | **PASS** |
| F12-U45 | recognises a well-formed signature by shape alone | **PASS** |

## F12 - signature verification and durable acceptance

`webhook-intake.e2e-spec.ts` — real PostgreSQL, real HTTP, the body signed and sent as one string

| Case | What it asserts | Result |
|---|---|---|
| F12-T01 | provisioning returns the secret once, with no-store | **PASS** |
| F12-T02 | reading the integration never returns a secret, in any form | **PASS** |
| F12-T03 | the signing secret is not stored in plaintext | **PASS** |
| F12-T04 | a company manager cannot provision an integration | **PASS** |
| F12-T10 | a correctly signed event is accepted | **PASS** |
| F12-T11 | a missing signature is refused | **PASS** |
| F12-T12 | a missing webhook id is refused | **PASS** |
| F12-T13 | a missing timestamp is refused | **PASS** |
| F12-T14 | a wrong signature is refused | **PASS** |
| F12-T15 | a signature of the wrong LENGTH is refused | **PASS** |
| F12-T16 | a signature in the wrong ENCODING is refused | **PASS** |
| F12-T17 | a signature computed with ANOTHER company’s secret is refused | **PASS** |
| F12-T18 | a modified body is refused, even with a signature that was valid | **PASS** |
| F12-T19 | re-serialised JSON with different whitespace is refused | **PASS** |
| F12-T20 | an expired signature timestamp is refused | **PASS** |
| F12-T21 | an excessively future-dated timestamp is refused | **PASS** |
| F12-T22 | a timestamp just inside the tolerance is accepted | **PASS** |
| F12-T23 | a non-numeric timestamp is refused | **PASS** |
| F12-T24 | an unknown delivery id is refused | **PASS** |
| F12-T25 | a refused delivery stores NOTHING | **PASS** |
| F12-T26 | the route is reachable without a session or the CSRF header | **PASS** |
| F12-T30 | a body that is not JSON is a 400, not a 500 | **PASS** |
| F12-T31 | a missing envelope field is a 400 | **PASS** |
| F12-T32 | a malformed payload field is a 400 naming it | **PASS** |
| F12-T33 | an unknown field INSIDE data is refused | **PASS** |
| F12-T34 | an unknown field on the ENVELOPE is tolerated | **PASS** |
| F12-T35 | an unsupported event type is ACCEPTED and ignored, not refused | **PASS** |
| F12-T36 | an unsupported type with a shape we could not parse is still accepted | **PASS** |
| F12-T40 | the event is bound to the company whose secret verified it | **PASS** |
| F12-T41 | the body cannot name a company | **PASS** |
| F12-T42 | two companies may use the same provider event id independently | **PASS** |
| F12-T50 | the same event delivered twice creates one row | **PASS** |
| F12-T51 | a redelivery signed afresh is still a duplicate | **PASS** |
| F12-T52 | two simultaneous deliveries of one event create one row | **PASS** |
| F12-T53 | the same event id with a DIFFERENT payment is refused | **PASS** |
| F12-T54 | acceptance does not create an expense | **PASS** |
| F12-T55 | a large body is refused by the existing size limit, not by us | **PASS** |

## F12 - asynchronous processing and recovery

`webhook-worker.e2e-spec.ts` — real PostgreSQL, the worker driven one event at a time rather than slept on

| Case | What it asserts | Result |
|---|---|---|
| F12-T60 | a pending event becomes an expense when a worker claims it | **PASS** |
| F12-T61 | draining an empty inbox does nothing | **PASS** |
| F12-T62 | the worker claims the oldest due event first | **PASS** |
| F12-T63 | an amount over the limit opens exactly one review | **PASS** |
| F12-T64 | a blocked category is REJECTED and opens NO review | **PASS** |
| F12-T65 | two rules firing give REJECT, with both reasons kept | **PASS** |
| F12-T66 | the frequency rule counts webhook expenses like any other | **PASS** |
| F12-T67 | a webhook expense and an identical API expense agree | **PASS** |
| F12-T70 | processing the same event twice creates one expense | **PASS** |
| F12-T71 | a worker that commits an expense and then dies recovers correctly | **PASS** |
| F12-T72 | an abandoned claim is not stolen while its lease is alive | **PASS** |
| F12-T73 | two workers claiming at the same moment do not get the same event | **PASS** |
| F12-T80 | a permanently invalid event fails terminally on the first attempt | **PASS** |
| F12-T80b | a terminal event is never claimed again | **PASS** |
| F12-T81 | a transient failure is retried, and bounded | **PASS** |
| F12-T82 | an ignored event is never processed | **PASS** |
| F12-T90 | an event is processed into the company it authenticated as | **PASS** |
| F12-T91 | an ordinary caller cannot collide with a webhook expense | **PASS** |
| F12-T92 | an ordinary caller still cannot duplicate its OWN externalId | **PASS** |
| F12-T95 | a manager resolves a webhook-originated review normally | **PASS** |

## F12 - the sandbox simulator

`simulator.e2e-spec.ts` — real PostgreSQL on a real listening port, so the simulator posts over HTTP

| Case | What it asserts | Result |
|---|---|---|
| F12-T100 | a valid simulation reaches the real endpoint and is accepted | **PASS** |
| F12-T101 | the simulated event becomes a real expense | **PASS** |
| F12-T102 | the currency comes from the company, not the caller | **PASS** |
| F12-T103 | no signing secret appears in the response, anywhere | **PASS** |
| F12-T110 | the invalid-signature preset is refused by the real verifier | **PASS** |
| F12-T111 | the expired-signature preset is refused by the real verifier | **PASS** |
| F12-T112 | a refused simulation creates no expense | **PASS** |
| F12-T120 | the replay preset redelivers the stored event, not a new one | **PASS** |
| F12-T121 | replaying an event that was never received is refused clearly | **PASS** |
| F12-T122 | the same event id with a different payment is a conflict | **PASS** |
| F12-T130 | a company manager is refused | **PASS** |
| F12-T131 | a company API key is refused for its kind | **PASS** |
| F12-T132 | an unauthenticated caller is refused | **PASS** |
| F12-T133 | CSRF protection applies to the simulator | **PASS** |
| F12-T134 | there is no destination parameter to override | **PASS** |
| F12-T135 | a company without an integration is refused clearly | **PASS** |
| F12-T136 | an unknown company is a 404 | **PASS** |
| F12-T140 | the history lists real events, filtered and paginated | **PASS** |
| F12-T141 | the history never carries a secret or a payload hash | **PASS** |
| F12-T142 | a manager cannot read the event history | **PASS** |
| F12-T150 | the simulator reports itself disabled | **PASS** |
| F12-T151 | a genuine administrator still cannot deliver a synthetic event | **PASS** |
| F12-T152 | the real webhook endpoint is unaffected by the flag | **PASS** |

---

## Total: 130 / 130
