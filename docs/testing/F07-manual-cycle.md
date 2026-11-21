# F07 - Manual test cycle

Twenty-two steps against the real stack. Every expected result below was
**observed** during F07 verification.

```bash
docker compose up --build
```

Credentials are in the README's *Development credentials* table.

> **Before you start.** The seed verifies its own row counts on every container
> start and **refuses to run** if extra rows are present. Several steps below
> create data; the cleanup at step 22 is not optional if you intend to restart
> the stack afterwards.

---

### 1. Sign in as the Nile Logistics manager

**Expected:** `/dashboard`. The sidebar now shows four live links - Overview,
Expenses, **Reviews**, **Policy**. No "F07" markers remain.

### 2. Read the overview

**Expected:** 8 / 5 / 1 / 2 and a blue notice: *1 expense waiting for a
decision*, with **Go to reviews** - not the F06 placeholder text.

### 3. Open the review queue

**Expected:** one row. City Taxi, `exp-1004`, `emp-7`, SAR 80.00, a
**Too frequent** chip. The filter reads *Waiting for a decision*.

### 4. Inspect the review

Click the row.

**Expected:** three badges - `Policy: Review`, `Pending review`, `Awaiting a
manager`. The decision box is **first**, above the evidence. Below it:

| | |
|---|---|
| Expenses in the window | **4 (including this one)** |
| Maximum allowed | **3** |
| Window | **1 hour** |

and the policy snapshot: limit SAR 500.00, 3 per 60 minutes, GAMBLING.

### 5. Approve it

Press **Approve expense**.

**Expected:** a dialog naming the **actual amount and merchant** - "SAR 80.00
at City Taxi will be marked approved" - not a generic "Are you sure?".

Confirm.

**Expected:** *"Approved by Nour Hassan. This review is closed and cannot be
resolved again."* The badges become `Approved` and `Approved by a manager`. The
**buttons are gone**.

### 6. Verify it left the queue

Go back to Reviews.

**Expected:** *"Nothing waiting for a decision"*, with a button to show all.

### 7. Verify the expense status

Expenses → find `exp-1004`.

**Expected:** `Review` / **`Approved`**. The policy decision did not change;
the status did.

### 8. Verify the dashboard

**Expected:** Pending review **0**, Approved **6**, and the note now reads
**2 approved by a manager**. The blue notice is gone.

---

## Creating a second review, and a real conflict

### 9. Submit an expense that trips the policy

```bash
KEY='<Nile Logistics API key from the README>'
curl -s -X POST http://localhost:3001/v1/expenses \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"externalId":"manual-f07-1","employeeId":"emp-manual",
       "amount":180000,"currency":"SAR","merchant":"Riyadh Office Supplies",
       "category":"EQUIPMENT","spentAt":"2026-11-20T10:00:00.000Z"}'
```

**Expected:** `"decision":"REVIEW"`, `"status":"PENDING_REVIEW"`,
`"reasons":[{"code":"AMOUNT_LIMIT"...`

### 10. Confirm it appears

Reload the dashboard.

**Expected:** Total **9**, Pending review **1**, and the new expense at the top
of Recent expenses. This is the documented refresh behaviour: a server-rendered
page reflects it on the next load.

### 11. Reproduce an already-resolved conflict

This needs **two independent sessions**. Two tabs sharing one cookie are not
two managers.

Create a second manager for the test only. The password below is a throwaway
for an account that does not exist until you create it, lives only in your
local development database, and is deleted at step 22 — it is not a seeded
credential and it grants nothing anywhere else:

```bash
HASH=$(node -e "console.log(require('bcryptjs').hashSync('Temp-Manual-Pass-1', 10))")
docker compose exec -T db psql -U limaz -d limaz -c "
INSERT INTO users (id, \"companyId\", email, \"passwordHash\", \"displayName\", role, \"createdAt\", \"updatedAt\")
SELECT gen_random_uuid(), c.id, 'manual-b@test.invalid', '$HASH', 'Manual Manager B', 'MANAGER', now(), now()
FROM companies c WHERE c.name = 'Nile Logistics';"
```

In the **browser**, open the new review and leave it on screen.

In a **terminal**, as manager B:

```bash
curl -s -c /tmp/b.cookie -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  -H 'x-limaz-client: 1' \
  -d '{"email":"manual-b@test.invalid","password":"Temp-Manual-Pass-1"}'

REVIEW_ID='<copy it from the browser URL>'
curl -s -b /tmp/b.cookie -X POST \
  "http://localhost:3000/api/v1/reviews/$REVIEW_ID/resolve" \
  -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  -H 'x-limaz-client: 1' -d '{"decision":"REJECT"}'
```

**Expected from curl:** 200, `"state":"RESOLVED"`, `"outcome":"REJECTED"`,
reviewer **Manual Manager B**.

### 12. Now press Approve in the browser

**Expected, and this is the step that matters:**

- The page does **not** say Approved.
- It says *"Rejected by Manual Manager B. They resolved it before your decision
  reached the server, so yours was not applied."*
- The badges show **Rejected** and **Rejected by a manager** - the real
  outcome.
- The review panel names Manual Manager B and the time.
- The action buttons are **gone**.
- No spinner stuck, no retry loop, the page still works.

### 13. Confirm the reviewer audit information

Reviews → *All reviews*.

**Expected:** each resolved row shows who decided it - "Approved by Nour
Hassan", "Rejected by Manual Manager B".

---

## Policy settings

### 14. Open the policy page

**Expected:** limit `500.00` (editable text, no grouping commas), frequency
`3` / `60`, one `GAMBLING` chip. **Save changes is disabled** - nothing has
changed.

Below the frequency fields: *"The rule fires on expense number **4** within 60
minutes — the count includes the expense being judged."*

### 15. Try an invalid value

Type `abc` in the limit.

**Expected:** an inline red message, Save stays disabled. Now try `100.005`:
*"SAR has 2 decimal places."* - **refused, not rounded**.

### 16. Change a permitted field

Set the limit to `750.50`.

**Expected:** *"You have unsaved changes"* and a **Discard changes** button.

Press **Save changes**.

**Expected:** *"Saved"* for a few seconds, "Last changed" updates, Save
disables again.

Verify what was actually stored:

```bash
docker compose exec db psql -U limaz -d limaz -c \
  "SELECT \"autoApproveLimitMinor\" FROM policies p
     JOIN companies c ON c.id = p.\"companyId\"
    WHERE c.name = 'Nile Logistics';"
```

**Expected: exactly `75050`.** Not 75049, not 75051. The conversion never
multiplies a float.

### 17. Submit a new expense under the changed policy

```bash
curl -s -X POST http://localhost:3001/v1/expenses \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"externalId":"manual-f07-2","employeeId":"emp-manual-2",
       "amount":80000,"currency":"SAR","merchant":"Under New Limit",
       "category":"OFFICE","spentAt":"2026-11-20T11:00:00.000Z"}'
```

SAR 800.00 is above the new SAR 750.50 limit.

**Expected:** `"decision":"REVIEW"`, and the rule hit records
`"autoApproveLimitMinor":75050` - the **new** limit.

### 18. Retry an older expense

Re-send the **exact** payload from step 9.

**Expected:** HTTP **200** (not 201), `"duplicate":true`, and
`"decision":"REVIEW"` with the rule hit still showing the **old** limit of
`50000`.

The retry returns the original decision. Idempotency is about the expense, not
about re-running the rules.

### 19. Confirm history was not rewritten

Open any older expense, for example `exp-1005`.

**Expected:** its *Policy in force when this was judged* still reads
**SAR 500.00**, unchanged by step 16. Its reasons and decision are untouched,
and the review you approved in step 5 is still approved.

### 20. Add and remove a blocked category

Type `casino games` and press **Add**.

**Expected:** the chip appears as **`CASINO GAMES`** - uppercased and
whitespace-collapsed, the same normalisation the expense pipeline applies. Add
it again: nothing happens, no duplicate.

Save, then:

```bash
curl -s -X POST http://localhost:3001/v1/expenses \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"externalId":"manual-f07-3","employeeId":"emp-manual-3",
       "amount":1000,"currency":"SAR","merchant":"Somewhere",
       "category":"Casino Games","spentAt":"2026-11-20T12:00:00.000Z"}'
```

**Expected:** `"decision":"REJECT"` with `BLOCKED_CATEGORY`. The category the
manager typed with different casing and spacing **matches**.

### 21. Sign in as the other company

Sign out, sign in as the Delta Consulting manager.

**Expected:**

- The policy page shows **Delta's** values - a different limit, 5 per 30
  minutes, `ALCOHOL` and `GAMBLING`. Your Nile edits are nowhere.
- The review queue shows no Nile reviews.
- Pasting a Nile review URL gives *"That review is not here"* - **404, not
  403**: confirming the row exists would turn the URL into a way to count a
  competitor's reviews.

### 22. Clean up

```bash
docker compose exec -T db psql -U limaz -d limaz -c "
UPDATE policies SET \"autoApproveLimitMinor\" = 50000, \"blockedCategories\" = ARRAY['GAMBLING']
  WHERE \"companyId\" = (SELECT id FROM companies WHERE name = 'Nile Logistics');
DELETE FROM reviews WHERE \"expenseId\" IN (SELECT id FROM expenses WHERE \"externalId\" LIKE 'manual-f07-%');
DELETE FROM expenses WHERE \"externalId\" LIKE 'manual-f07-%';
UPDATE reviews r SET state = 'OPEN', outcome = NULL, \"resolvedByUserId\" = NULL, \"resolvedAt\" = NULL
  FROM expenses e WHERE e.id = r.\"expenseId\" AND e.\"externalId\" = 'exp-1004';
UPDATE expenses SET status = 'PENDING_REVIEW' WHERE \"externalId\" = 'exp-1004';
DELETE FROM sessions WHERE \"userId\" IN (SELECT id FROM users WHERE email = 'manual-b@test.invalid');
DELETE FROM users WHERE email = 'manual-b@test.invalid';"
```

**Expected afterwards:** 12 expenses, 3 reviews, 1 open, 3 users - and
`docker compose up` starts cleanly.

---

## Responsive check

Repeat steps 3, 4 and 14 at **360**, **390**, **768**, **1024**, **1440** and
**1920**.

**Expected:** no horizontal page scrolling anywhere. Below `sm` the approve and
reject buttons go full-width and stack; the policy fields stack; the review
queue stays a card list at every width, because a review carries a
variable-length list of reasons that a table column would have to truncate into
uselessness.
