# F06 - Manual test cycle

Fourteen steps, run against the real stack with the seeded accounts. Every
expected result below was **observed** during F06 verification, not predicted.

```bash
docker compose up --build
```

Wait for all three services to report `healthy`, then open
<http://localhost:3000>.

Credentials are in the README's *Development credentials* table. They are
deliberately not repeated here and deliberately not shown on the sign-in page.

---

## The cycle

### 1. Sign in as the first company's manager

Use the **Nile Logistics** manager.

**Expected:** `/dashboard`, sidebar reading `Company workspace / Nile
Logistics`, the user menu showing *Nour Hassan · Manager*.

---

### 2. Read the overview figures

**Expected, exactly:**

| Card | Value | Note under it |
|---|---|---|
| Total expenses | **8** | `SAR 2,965.00 all time` |
| Approved | **5** | `1 approved by a manager` |
| Pending review | **1** | `Waiting on a decision` (amber) |
| Rejected | **2** | `All rejected by policy` |

Then a blue notice: *1 expense waiting for a decision*, with a link.

**What to check, and why it matters:** 5 + 1 + 2 = 8. The three status counts
**must** sum to the total. They come from one `groupBy`, so they do - four
separate counts would be four database snapshots and could disagree.

**And the one that is easy to miss:** the *Approved* card says **1 approved by a
manager**. That expense (`exp-1005`) was flagged by the policy. It is counted as
approved, **not pending**, because the count uses the current status.

Cross-check against the database if you like:

```bash
docker compose exec db psql -U limaz -d limaz \
  -c "SELECT status, count(*) FROM expenses e
      JOIN companies c ON c.id = e.\"companyId\"
      WHERE c.name = 'Nile Logistics' GROUP BY 1;"
```

---

### 3. Open the expense listing

Click **Expenses** in the sidebar, or **View all expenses**.

**Expected:** 8 rows, newest first by **spent** date, starting with JetBrains
`exp-1008` at `Nov 18, 2026, 16:00` and ending with City Taxi `exp-1001` at
`12:00`. The footer reads `8 expenses on page 1`; both **Newer** and **Older**
are disabled.

---

### 4. Search for a known expense

Type `jarir` in the search box.

**Expected:** one row, Jarir Bookstore, `SAR 1,250.00`. The URL becomes
`?q=jarir`.

**Watch the address bar while you type.** It updates once, after you stop -
not once per keystroke. Five characters produce **one** API request.

Try `exp-1001` and `emp-9` too: search covers the merchant, the external
reference and the employee reference.

---

### 5. Filter by pending review

Clear the search, then set **Status → Pending review**.

**Expected:** one row, City Taxi `exp-1004`, `Pending review`. The Status
control turns blue, and a **Clear filters** button appears next to it.

**Now the interesting one.** Set **Status → Any status** and **Policy decision →
Flagged for review**.

**Expected: two rows** - `exp-1004` (pending) and `exp-1005` (approved).

That difference is the whole point of having both filters. *Flagged by the
policy* is a strictly larger set than *still waiting*, because some flagged
expenses have already been decided.

---

### 6. Open an expense with a policy reason

Clear the filters and click **City Taxi `exp-1004`**.

**Expected:** a *Why the policy decided this* card reading **Too many expenses
in a short window**, with:

| | |
|---|---|
| Expenses in the window | **4 (including this one)** |
| Maximum allowed | **3** |
| Window | **1 hour** |

The count **includes** the expense you are looking at - the label says so,
because "4 previous expenses" would be off by one and would look like a bug in
the rule rather than in the wording.

For an expense with **two** reasons, open `exp-1007` (Casino Royale, `SAR
800.00`): both `AMOUNT_LIMIT` and `BLOCKED_CATEGORY` are listed, alphabetically.

---

### 7. Inspect the historical policy snapshot

Still on `exp-1004`, read *Policy in force when this was judged*:

| | |
|---|---|
| Auto-approval limit | `SAR 500.00` |
| Frequency rule | `3 expenses per 60 minutes` |
| Blocked categories | `GAMBLING` |

**Prove it is historical.** Change the live policy:

```bash
docker compose exec db psql -U limaz -d limaz \
  -c "UPDATE policies SET \"autoApproveLimitMinor\" = 99999900
      WHERE \"companyId\" = (SELECT id FROM companies WHERE name = 'Nile Logistics');"
```

Reload the page.

**Expected: nothing changes.** The limit still reads `SAR 500.00`, the decision
is still REVIEW, the reason is still there.

That is assumption A7 working: the snapshot was captured at submission, so *why
was this flagged?* stays answerable after somebody edits the policy. Reading the
live policy instead would silently show the wrong limit for every expense older
than the last edit.

Put it back:

```bash
docker compose exec db psql -U limaz -d limaz \
  -c "UPDATE policies SET \"autoApproveLimitMinor\" = 50000
      WHERE \"companyId\" = (SELECT id FROM companies WHERE name = 'Nile Logistics');"
```

---

### 8. Open a manually resolved expense

Go back and open **Jarir Bookstore `exp-1005`**.

**Expected** in *Human review*:

| | |
|---|---|
| Outcome | **Approved by a manager** |
| Opened | `Nov 18, 2026, 13:00` |
| Reviewed by | `Nour Hassan` |
| Resolved | `Nov 18, 2026, 13:30` |

Opened **before** resolved. (It did not read that way during F06 verification -
see AI_LOG 34.)

Only the reviewer's **name** is shown. No email address, no identifier beyond
what is needed to say who acted.

---

### 9. Check the decision / status distinction

On the same page, look at the header badges:

```
Policy: Review        Current status: Approved
```

**These are not contradictory, and the page says why:** *"The policy said
reviewable; a manager then decided. Both facts are kept - neither replaces the
other."*

`decision` records what the engine concluded at submission and never changes.
`status` records where the expense stands now. Merging them would lose the
answer to *what did the policy originally say?*

---

### 10. Test pagination

The seed has 8 expenses, which is one page. To see two, submit some:

```bash
KEY='<the Nile Logistics API key from the README>'
for i in $(seq 1 30); do
  curl -s -o /dev/null -X POST http://localhost:3001/v1/expenses \
    -H "x-api-key: $KEY" -H 'content-type: application/json' \
    -d "{\"externalId\":\"page-demo-$i\",\"employeeId\":\"emp-page-$i\",
         \"amount\":$((1000 + i)),\"currency\":\"SAR\",
         \"merchant\":\"Pagination Demo $i\",\"category\":\"OFFICE\",
         \"spentAt\":\"2026-11-10T$(printf '%02d' $((8 + i % 12))):00:00.000Z\"}"
done
```

Reload the listing.

**Expected:** 25 rows and `25 expenses on page 1`, with **Older** now enabled.
Click it.

**Expected:** `13 expenses on page 2`, **Newer** enabled, **Older** disabled.
The URL carries an opaque `cursor`.

**Now change a filter while on page 2.** Set **Status → Pending review**.

**Expected:** the URL becomes `?status=PENDING_REVIEW` with **no `cursor`**. The
cursor is dropped, because it means "continue after this row *under these
filters*" - carrying it would drop you into the middle of a list whose beginning
you never saw.

This step also demonstrates that **a newly submitted expense appears**: these 30
arrived through the API exactly as a company's integration would send them, and
the dashboard shows them on the next load.

Clean up when you are done:

```bash
docker compose exec db psql -U limaz -d limaz \
  -c "DELETE FROM expenses WHERE \"externalId\" LIKE 'page-demo-%';"
```

---

### 11. Resize to mobile and tablet

Narrow the window, or use the browser's device toolbar, at **360**, **390**,
**768**, **1024**, **1440** and **1920**.

**Expected:**

| Width | What changes |
|---|---|
| 360 / 390 | The table becomes **cards**. The sidebar becomes a drawer behind the ☰ button. Summary cards go 2×2. Filters stack full-width |
| 768 | Still cards, still a drawer. The detail page is one column |
| 1024 | The sidebar appears. The table appears; Category and Spent are hidden until there is room |
| 1440 | Four summary cards in a row, the full table, a two-column detail page |
| 1920 | The content stays at a readable width and centres - it does not stretch |

**Check specifically:** no horizontal page scrolling at any width, nothing
clipped, and **nothing hidden**. Both badges, the reference, the employee, the
category and the date are all on the mobile card. A smaller screen gets a
different layout, not less information.

Open the ☰ drawer: it slides in over ~200ms and the overlay fades. Press
**Escape** - it closes the same way. (With *reduce motion* on in your operating
system, both are instant.)

---

### 12. Sign out

User menu → **Sign out**.

**Expected:** `/login?reason=signedout`.

---

### 13. Sign in as the second company's manager

Use the **Delta Consulting** manager.

**Expected:** `/dashboard`, sidebar reading `Delta Consulting`, user menu *Omar
Fathy*.

| Card | Value |
|---|---|
| Total expenses | **4** |
| Approved | **2** |
| Pending review | **0** → *Nothing waiting* |
| Rejected | **2** → `1 rejected by a manager` |

Delta's listing shows **Beans Cafe, Duty Free, Saudia, Careem** - four rows.

Note `exp-2002` (Saudia): `Policy: Review` + `Rejected`. The mirror of Nile's
`exp-1005` - flagged, then rejected by a human.

---

### 14. Verify no previous-company data is visible

Three checks, in order of strength:

**a. The listing.** Nothing from Nile. No Casino Royale, no JetBrains, no Jarir
Bookstore. Search `casino` - **no results**, even though Nile has two.

**b. A direct link.** Paste a Nile expense URL into the address bar while signed
in as Delta:

```
http://localhost:3000/dashboard/expenses/0193f0e0-0000-7000-8000-000000000005
```

**Expected:** *"That expense is not here - it does not exist, or it belongs to
another company."*

**404, not 403.** The two cases are deliberately indistinguishable: a 403 would
confirm the row exists, which would turn this URL into a way to count a
competitor's expenses by walking ids.

**c. The cache.** This is the one that catches a real class of bug. Sign out,
sign back in as **Nile**, and go straight to the listing **without reloading the
page**.

**Expected:** Nile's 8 rows immediately. Not Delta's 4 from a stale cache, and
not an empty table.

The query cache is mounted with `key={user.id}`, so a different user does not
get a cleared cache - they get a **new one**. There is nothing to clear and
nothing to forget to clear.

---

## What you will not find, and why

| Not there | Why |
|---|---|
| Approve / reject buttons | **F07.** The pages say so where you would look for them, rather than showing a control that does nothing |
| Charts, trends, "+12% this month" | Every one would have to be invented. The system records no history of its own counts |
| A date-range filter | Optional in the brief; it would complicate the pagination cursor to answer a question nothing asks |
| An export button | Not required |
| A "submit expense" form | Expenses are submitted by a company's backend with an API key. A person submitting through the dashboard would bypass the integration their company runs |
