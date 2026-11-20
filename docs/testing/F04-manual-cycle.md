# F04 manual test cycle

PowerShell 7 on Windows, against the Docker stack. **Everything here runs
today** - `POST /v1/expenses` is live.

## The one rule that makes repeated runs trustworthy

**Derive the employee id from the run, not just the external id.**

A reused `externalId` is caught immediately: the second submission is a 200 or
a 409 and you notice. A reused `employeeId` is **silent** - the frequency
window inherits the previous run's expenses, and your first expense comes back
REVIEW when it should be APPROVE.

That is not hypothetical. It happened while writing this guide, and the
expense data was correct; the test was wrong. See the F04 matrix.

## Setup

```powershell
docker compose up -d
docker compose ps        # db, api and web must all read healthy
```

```powershell
$api = 'http://localhost:3000/api'
# The development keys are published in ONE place - the README's
# "Development credentials" table - and are deliberately not repeated here.
$nile  = '<Nile Logistics key from the README>'
$delta = '<Delta Consulting key from the README>'

# A per-run identifier. Everything below derives from it.
$run = "run$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$emp = "emp-$run"
$ts  = [DateTime]::UtcNow.AddMinutes(-10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
```

A helper, so each scenario is one line:

```powershell
function Submit {
  param($Key, $ExternalId, $Employee, $Amount, $Category)
  $body = @{
    externalId = $ExternalId; employeeId = $Employee; amount = $Amount
    currency = 'SAR'; merchant = 'Shop'; category = $Category; spentAt = $ts
  } | ConvertTo-Json
  try {
    $r = Invoke-WebRequest "$api/v1/expenses" -Method Post -Body $body `
          -Headers @{ 'x-api-key' = $Key; 'content-type' = 'application/json' }
    $o = $r.Content | ConvertFrom-Json
    "{0}  {1}  [{2}]{3}" -f $r.StatusCode, $o.decision,
      ($o.reasons.code -join '|'), $(if ($o.duplicate) { '  DUPLICATE' })
  } catch {
    "{0}  {1}" -f $_.Exception.Response.StatusCode.value__,
      ($_.ErrorDetails.Message | ConvertFrom-Json).error
  }
}
```

Confirm the stack and the key first - if this fails, nothing below is
meaningful:

```powershell
Invoke-RestMethod "$api/v1/auth/me" -Headers @{ 'x-api-key' = $nile }
```

Expected: `callerType: api-key`, `company.name: Nile Logistics`, `user: null`.

**Company A policy:** limit 50,000 minor units (500.00 SAR), maxCount 3,
window 60 minutes, blocked `['GAMBLING']`.
**Company B policy:** limit 200,000, maxCount 5, window 30 minutes, blocked
`['ALCOHOL', 'GAMBLING']`.

---

## 1. A normal approved expense

```powershell
Submit $nile "$run-a" $emp 1000 'TRANSPORT'
```

| | |
|---|---|
| **Expected HTTP** | `201` |
| **Expected decision** | `APPROVE` |
| **Expected reasons** | none |
| **Expected database** | status `APPROVED`, no rule hits, no review, `policySnapshot` populated |
| **Observed** | `201 APPROVE []` |

---

## 2. Above the amount limit

```powershell
Submit $nile "$run-b" "$emp-2" 60000 'TRANSPORT'
```

| | |
|---|---|
| **Precondition** | 60,000 > the 50,000 limit |
| **Expected** | `201` · `REVIEW` · `[AMOUNT_LIMIT]` |
| **Database** | status `PENDING_REVIEW`, one rule hit with `{autoApproveLimitMinor: 50000, amountMinor: 60000}`, **one OPEN review** |
| **Observed** | `201 REVIEW [AMOUNT_LIMIT]` |

Check the boundary while you are here - `50000` approves, `50001` reviews:

```powershell
Submit $nile "$run-edge1" "$emp-e1" 50000 'TRANSPORT'   # APPROVE
Submit $nile "$run-edge2" "$emp-e2" 50001 'TRANSPORT'   # REVIEW
```

---

## 3. A blocked category

```powershell
Submit $nile "$run-c" "$emp-3" 1000 'GAMBLING'
```

| | |
|---|---|
| **Expected** | `201` · `REJECT` · `[BLOCKED_CATEGORY]` |
| **Database** | status `REJECTED`, one rule hit, **no review** - a rejected expense is final, so there is nothing for a manager to do |
| **Observed** | `201 REJECT [BLOCKED_CATEGORY]` |

Casing and padding must not matter:

```powershell
Submit $nile "$run-c2" "$emp-3b" 1000 '  gambling  '   # still REJECT
```

---

## 4. Four expenses in the window

```powershell
1..4 | ForEach-Object { Submit $nile "$run-f$_" "$emp-freq" 1000 'TRANSPORT' }
```

| | |
|---|---|
| **Precondition** | `$emp-freq` has **no history** - which is why the employee id carries `$run` |
| **Expected** | three `201 APPROVE []`, then `201 REVIEW [FREQUENCY]` |
| **Database** | four rows; the fourth has a FREQUENCY hit with `{windowMinutes: 60, maxCount: 3, countIncludingCurrent: 4}` and one OPEN review |
| **Observed** | `APPROVE`, `APPROVE`, `APPROVE`, `REVIEW [FREQUENCY] count=4` |

Three is not greater than three. The fourth is the first to exceed it.

---

## 5. All three rules at once

```powershell
Submit $nile "$run-x" "$emp-freq" 60000 'GAMBLING'
```

| | |
|---|---|
| **Precondition** | Run scenario 4 first, so this is the fifth in the window |
| **Expected** | `201` · `REJECT` · `[AMOUNT_LIMIT|BLOCKED_CATEGORY|FREQUENCY]` |
| **Database** | **three rule hits**, status `REJECTED`, and **zero reviews** |
| **Observed** | `201 REJECT [AMOUNT_LIMIT|BLOCKED_CATEGORY|FREQUENCY] count=5` |

The row to read twice: three reasons, **two of them REVIEW**, and no review
opened - because REJECT is final and wins.

---

## 6. An identical retry

```powershell
Submit $nile "$run-b" "$emp-2" 60000 'TRANSPORT'
```

| | |
|---|---|
| **Expected** | `200`, not `201`. Same decision, same reasons, `duplicate: true` |
| **Database** | still one row; **no second rule hit, no second review**, nothing added to the window |
| **Observed** | `200 REVIEW [AMOUNT_LIMIT] DUPLICATE` |

---

## 7. A conflicting retry

```powershell
Submit $nile "$run-b" "$emp-2" 70000 'TRANSPORT'
```

| | |
|---|---|
| **Expected** | `409`, `error: conflict`, with `details.existing` naming the original |
| **Database** | the stored amount is still **60000**, not 70000 |
| **Observed** | `409 conflict` |

To correct an expense, submit a **new** `externalId`.

---

## 8. The same externalId across two companies

```powershell
Submit $delta "$run-b" "$emp-2" 60000 'TRANSPORT'
```

| | |
|---|---|
| **Expected** | `201 APPROVE` - company B's limit is 200,000, so 60,000 is fine |
| **Database** | two rows sharing `externalId`, different `companyId`, **different decisions** |
| **Observed** | `201 APPROVE []` |

Uniqueness is on `(companyId, externalId)`. The same expense gets different
answers because the policies differ, which is the point of per-company policy.

---

## 9. Concurrent submissions

```powershell
$cEmp = "emp-conc-$run"
$jobs = 1..5 | ForEach-Object {
  Start-ThreadJob -ArgumentList $api, $nile, $run, $cEmp, $ts, $_ {
    param($api, $key, $run, $emp, $ts, $i)
    $body = @{
      externalId = "$run-conc-$i"; employeeId = $emp; amount = 1000
      currency = 'SAR'; merchant = 'Shop'; category = 'TRANSPORT'; spentAt = $ts
    } | ConvertTo-Json
    (Invoke-WebRequest "$api/v1/expenses" -Method Post -Body $body `
      -Headers @{ 'x-api-key' = $key; 'content-type' = 'application/json' }).StatusCode
  }
}
$jobs | Wait-Job | Receive-Job
```

| | |
|---|---|
| **Expected** | five `201`. No `500`, no timeout |
| **Expected database** | **3 APPROVE, 2 REVIEW, 2 OPEN reviews, 2 FREQUENCY hits** |
| **Observed** | `APPROVE 3 · REVIEW 2 · open reviews 2` |

**Read this as a smoke test, not as proof.** `Start-ThreadJob` gives no
control over whether the requests genuinely overlap inside the database. The
automated version holds all five at a barrier **before** the transaction
opens, and the negative control shows the same scenario producing five
APPROVEs once the advisory lock is removed. That pair is the evidence;
this is the demonstration.

---

## 10. Verifying the database

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "SELECT e.\"externalId\", e.decision, e.status,
     (SELECT string_agg(rh.\"ruleCode\"::text, '+' ORDER BY rh.\"ruleCode\")
        FROM rule_hits rh WHERE rh.\"expenseId\" = e.id) AS reasons,
     (SELECT count(*) FROM reviews r WHERE r.\"expenseId\" = e.id) AS reviews,
     e.\"policySnapshot\"->>'autoApproveLimitMinor' AS snap_limit
   FROM expenses e WHERE e.\"employeeId\" LIKE '%$run%' ORDER BY e.\"createdAt\";"
```

What to check:

| Column | Invariant |
|---|---|
| `decision` / `status` | APPROVE→APPROVED, REVIEW→PENDING_REVIEW, REJECT→REJECTED. A CHECK constraint makes anything else unstorable |
| `reasons` | Every triggered rule, including ones whose verdict lost to a stronger one |
| `reviews` | `1` for REVIEW, `0` for APPROVE **and for REJECT** |
| `snap_limit` | The limit in force when the expense was decided |

**`ORDER BY "ruleCode"` returns enum-declaration order**, not alphabetical:
`AMOUNT_LIMIT, FREQUENCY, BLOCKED_CATEGORY`. The API response sorts in
JavaScript and *is* alphabetical. Expect the two to differ.

Duplicates, which must always be empty:

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "SELECT \"companyId\", \"externalId\", count(*) FROM expenses
   GROUP BY 1,2 HAVING count(*) > 1;"
```

Snapshots unchanged by a later policy edit - change a limit, then re-read an
older expense and confirm its `policySnapshot` still shows the old value.

---

## Cleaning up a manual run

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "DELETE FROM reviews WHERE \"expenseId\" IN
     (SELECT id FROM expenses WHERE \"employeeId\" LIKE '%$run%');
   DELETE FROM expenses WHERE \"employeeId\" LIKE '%$run%';"
```

Rule hits cascade with the expense. Reviews do not - they are `onDelete:
Restrict` - so they go first.

Or simply start a new `$run`: every identifier derives from it, so runs never
collide.
