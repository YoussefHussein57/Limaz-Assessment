# F08 - Manual test cycle

Twenty-four steps against the real stack. Every expected result below was
**observed** during F08 verification.

```bash
docker compose up --build
```

Sign in as the **platform administrator** from the README's credentials table.

> **Before you start.** The seed verifies its own row counts on every
> container start and refuses to run if extra rows are present. Step 24 is not
> optional if you intend to restart the stack.

---

### 1. Sign in as the platform administrator

**Expected:** `/admin`, headed **Companies**. The sidebar reads *Platform
administration* and has one entry. No manager pages are offered.

### 2. Read the list

**Expected:** Nile Logistics and Delta Consulting, each with currency, the date
added, a short id, and a **1 active key** badge.

That badge is not a stored flag: it counts keys that can authenticate *right
now*, using the same predicate authentication uses. A company with none shows
a red **No working key**.

### 3. Create a company

**Add a company** → name `Jeddah Maritime`, currency `SAR`, limit `1200.00`.

Read the note before submitting: *"No manager account is created."*

**Expected on submit:** a dialog headed **Jeddah Maritime created**, containing
the full API key, a **Copy key** button, and a warning that this is the only
time it is shown.

### 4. Verify the database state

```bash
docker compose exec db psql -U limaz -d limaz -c "
SELECT c.name, p.\"autoApproveLimitMinor\", p.\"frequencyMaxCount\",
       k.prefix, k.status
  FROM companies c
  JOIN policies p ON p.\"companyId\" = c.id
  JOIN api_keys k ON k.\"companyId\" = c.id
 WHERE c.name = 'Jeddah Maritime';"
```

**Expected:** one row. `autoApproveLimitMinor` is **exactly `120000`** - the
string `1200.00` converted without floating-point arithmetic. The policy and
the key exist because all three were written in one transaction.

### 5. Confirm the raw key is not stored

```bash
docker compose exec db psql -U limaz -d limaz -c \
  "SELECT prefix, left(\"keyHash\", 16) || '…' AS hash FROM api_keys ORDER BY \"createdAt\" DESC LIMIT 1;"
```

**Expected:** a 16-character prefix and a SHA-256 hash. The plaintext is
nowhere in the table.

### 6. Submit a real expense with the new key

Copy the key from the dialog, then:

```bash
KEY='<the key you just copied>'
curl -s -X POST http://localhost:3001/v1/expenses \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"externalId":"f08-manual-1","employeeId":"emp-1",
       "amount":250000,"currency":"SAR","merchant":"First Supplier",
       "category":"OFFICE","spentAt":"2026-11-21T09:00:00.000Z"}'
```

**Expected:** `201`, `"decision":"REVIEW"`, and the rule hit carrying
`"autoApproveLimitMinor":120000` — **the policy created in that same
transaction is the one deciding**.

### 7. Close the dialog and look for the key

**Expected:** the company details page. The key row shows **only the prefix**
followed by `…`. The full value is not on the page, and no reload or
navigation brings it back.

Check the browser's storage (DevTools → Application):

**Expected:** `localStorage` and `sessionStorage` both **empty**. The URL
contains no key.

### 8. Read the no-manager warning

**Expected:** an amber panel at the top: this company has no manager account,
its backend can submit but nobody can sign in to review, and creating manager
accounts is not automated in this version.

That is assumption A5 made visible rather than left to be discovered.

### 9. Read the policy panel

**Expected:** `SAR 1,200.00`, `3 per 60 min`, `None`, and underneath:
*"Read only here. Changing a company's spending rules is its manager's
authority, not an administrator's."*

### 10. Look for the company's expenses

**Expected: there are none to find.** No link, no tab, no list. Managing an
account is not reading spending, and the API refuses expense routes to an
administrator regardless.

### 11. Rotate the key

**Rotate** → read the confirmation.

**Expected:** it names the current key's prefix and says the old key keeps
working for **24 hours**.

Confirm.

**Expected:** a new secret dialog, then two rows:

| Key | State |
|---|---|
| the new one | **Active**, with Rotate and Revoke |
| the old one | **Grace period**, "stops working \<24 hours from now\>", with only **Revoke now** |

"Working API keys" reads **2**.

### 12. Verify both keys authenticate

Submit with the **old** key:

```bash
curl -s -o /dev/null -w "old key -> %{http_code}\n" -X POST http://localhost:3001/v1/expenses \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"externalId":"f08-manual-2","employeeId":"emp-1","amount":1000,
       "currency":"SAR","merchant":"Still Works","category":"OFFICE",
       "spentAt":"2026-11-21T09:05:00.000Z"}'
```

**Expected: 201.** This is the grace window doing its job - without it, every
rotation would be an outage.

Now the new key, same expectation.

### 13. Verify the old key stops after the grace window

Rather than waiting 24 hours, move the expiry into the past - the state the
clock would reach:

```bash
docker compose exec db psql -U limaz -d limaz -c "
UPDATE api_keys SET \"expiresAt\" = now() - interval '1 second'
 WHERE status = 'ROTATING'
   AND \"companyId\" = (SELECT id FROM companies WHERE name = 'Jeddah Maritime');"
```

Submit with the old key again.

**Expected: 401.** And it is the **same body** an unknown key gets - telling
an expired key apart from an unknown one would tell an attacker which guess
was closer.

Reload the company page.

**Expected:** that row now reads **Expired**, with no actions.

### 14. Refuse to rotate an expired key

The UI offers no Rotate on it. Try the API directly:

```bash
COMPANY=$(docker compose exec -T db psql -U limaz -d limaz -t -A -c \
  "SELECT id FROM companies WHERE name = 'Jeddah Maritime';")
KEYID=$(docker compose exec -T db psql -U limaz -d limaz -t -A -c \
  "SELECT id FROM api_keys WHERE status = 'ROTATING' AND \"companyId\" = '$COMPANY';")
```

Rotate it as the administrator (through the browser's session, or by signing in
with curl as in the F07 cycle).

**Expected: 409**, with a message naming the real state - *"already been
rotated and is in its grace period"*. Rotating it would push its expiry another
24 hours out: rotate twice, live forever.

### 15. Revoke the active key

**Revoke** → read the confirmation.

**Expected:** danger styling, and it says the key stops **immediately**, with
no grace period, and that rotation is the routine alternative.

Confirm, then submit with that key.

**Expected: 401**, immediately. No grace - that is the whole difference.

### 16. Revoke it again

**Expected:** it succeeds again, and the **revocation timestamp does not
change**. That timestamp is audit data: when the credential actually stopped
working. A second click must not move it.

### 17. Try a mismatched company and key

Take a key id belonging to Nile Logistics and call it under Jeddah's company
id.

**Expected:** refused, and Nile's key is **untouched** - still Active, still
authenticating. Without matching on both ids, this would break a company the
administrator was not looking at while the logs named the other one.

### 18. Sign out and in as a company manager

**Expected:** the manager workspace, with no administration entry in the
sidebar.

### 19. Visit `/admin` directly

**Expected:** a 403 page explaining that the area is for platform
administrators, with a way back. Their own navigation is still visible.

### 20. Call the admin API as the manager

In the browser console:

```js
await (await fetch('/api/v1/admin/companies', { headers: { 'x-limaz-client': '1' } })).json()
```

**Expected:** `403` with `"error":"insufficient_role"`. The page is a
courtesy; **this** is the enforcement.

Try creating a company the same way.

**Expected:** 403, and nothing is created.

### 21. Call the admin API with a company API key

```bash
curl -s -o /dev/null -w "api key -> %{http_code}\n" \
  http://localhost:3001/v1/admin/companies -H "x-api-key: <a seeded key>"
```

**Expected: 403.** `@Roles` implies a human caller - a key has no role, so one
decorator closes both doors.

### 22. Confirm the seeded companies still work

Sign in as each seeded manager.

**Expected:** their dashboards, expenses, reviews and policy pages are exactly
as before. F08 added administration; it changed nothing a manager sees.

### 23. Responsive check

Repeat steps 2, 3 and 11 at **360**, **390**, **768**, **1024**, **1440** and
**1920**.

**Expected:** no horizontal page scrolling. Below `sm` the key actions go
full-width and stack, the create dialog fills the width with a gutter, and the
integration snippet scrolls inside its own box rather than widening the page.

### 24. Clean up

```bash
docker compose exec -T db psql -U limaz -d limaz -c "
DELETE FROM rule_hits WHERE \"expenseId\" IN (
  SELECT e.id FROM expenses e JOIN companies c ON c.id = e.\"companyId\"
   WHERE c.name = 'Jeddah Maritime');
DELETE FROM reviews  WHERE \"companyId\" IN (SELECT id FROM companies WHERE name = 'Jeddah Maritime');
DELETE FROM expenses WHERE \"companyId\" IN (SELECT id FROM companies WHERE name = 'Jeddah Maritime');
DELETE FROM api_keys WHERE \"companyId\" IN (SELECT id FROM companies WHERE name = 'Jeddah Maritime');
DELETE FROM policies WHERE \"companyId\" IN (SELECT id FROM companies WHERE name = 'Jeddah Maritime');
DELETE FROM companies WHERE name = 'Jeddah Maritime';"
```

**Expected afterwards:** 2 companies, 12 expenses, 2 keys, 3 users — and
`docker compose up` starts cleanly.

---

## A note on handling the key during this cycle

The key you copy in step 3 is a **real credential for a real company on your
local database**. Treat it as one:

- do not paste it into a shared terminal, a ticket, or a screenshot
- do not commit a file containing it
- step 24 deletes the company it belongs to, which is the end of it

If you take screenshots of step 3, mask the field **in the image**. Setting the
input's value in DevTools is not enough - React re-renders from its own state
and restores the real value, which is exactly how a live key ended up in a
capture during this feature's own verification (AI_LOG 43).
