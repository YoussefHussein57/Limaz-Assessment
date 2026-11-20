# F05 manual test cycle

PowerShell 7 on Windows, against the Docker stack. Everything here runs today.

## Setup

```powershell
docker compose up -d
docker compose ps        # db, api and web must all read healthy

$api = 'http://localhost:3000/api'
# Development credentials are published in ONE place - the README's
# "Development credentials" table - and deliberately not repeated here.
$key      = '<Nile Logistics API key from the README>'
$email    = 'manager@nile-logistics.test'
$password = '<that manager password from the README>'

# A per-run identifier. Every id below derives from it, so repeated runs
# never contaminate each other's frequency windows.
$run = "run$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$ts  = [DateTime]::UtcNow.AddMinutes(-10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
```

**Derive the employee id from `$run`, not just the external id.** A reused
`externalId` is caught by the 409; a reused `employeeId` is silent and
inherits the previous run's frequency window (the F04 lesson).

### Sign in and keep the session

```powershell
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod "$api/v1/auth/login" -Method Post -WebSession $session `
  -Headers @{ 'x-limaz-client' = '1'; 'origin' = 'http://localhost:3000' } `
  -ContentType 'application/json' `
  -Body (@{ email = $email; password = $password } | ConvertTo-Json) | Out-Null

# Every manager request needs the CSRF header and a matching Origin (F02).
$mgr = @{ 'x-limaz-client' = '1'; 'origin' = 'http://localhost:3000' }
```

Never print `$session` or the cookie it holds.

---

## 1. Submit an expense that needs review

```powershell
$body = @{
  externalId = "$run-a"; employeeId = "emp-$run"; amount = 60000
  currency = 'SAR'; merchant = 'Shop'; category = 'TRANSPORT'; spentAt = $ts
} | ConvertTo-Json

$expense = Invoke-RestMethod "$api/v1/expenses" -Method Post `
  -Headers @{ 'x-api-key' = $key } -ContentType 'application/json' -Body $body

$expense | Select-Object id, decision, status
```

| | |
|---|---|
| **Precondition** | 60,000 is over company A's 50,000 limit |
| **Expected** | `201` · `decision REVIEW` · `status PENDING_REVIEW` |
| **Database** | one expense, one `AMOUNT_LIMIT` rule hit, **one OPEN review** |
| **Observed** | `REVIEW` |

---

## 2-3. List the open reviews

```powershell
$list = Invoke-RestMethod "$api/v1/reviews" -WebSession $session -Headers $mgr
$list.items | Select-Object id, state, @{n='amount';e={$_.expense.amountMinor}},
                                        @{n='reasons';e={$_.reasonCodes -join ','}}
$list.nextCursor

$review = $list.items | Where-Object { $_.expense.externalId -eq "$run-a" }
```

| | |
|---|---|
| **Expected** | `200`, `items` containing the new review, every item `state: OPEN` |
| **Note** | `nextCursor` is `null` unless there are more than `limit` (default 50) |
| **Observed** | 2 open reviews, `nextCursor: null` |

---

## 4. Read it in full

```powershell
$detail = Invoke-RestMethod "$api/v1/reviews/$($review.id)" -WebSession $session -Headers $mgr
$detail | Select-Object state, resolution,
  @{n='policy';e={$_.expense.decision}}, @{n='status';e={$_.expense.status}},
  @{n='reasons';e={($_.reasons.code) -join ','}}
$detail.policySnapshot
```

| | |
|---|---|
| **Expected** | `state OPEN` · `resolution null` · `expense.decision REVIEW` · `expense.status PENDING_REVIEW` · `reasons AMOUNT_LIMIT` · snapshot present |
| **Observed** | exactly that |

The two expense fields are different facts: `decision` is what the policy
concluded and never changes; `status` is the current outcome.

---

## 5. Approve it

```powershell
$resolved = Invoke-RestMethod "$api/v1/reviews/$($review.id)/resolve" -Method Post `
  -WebSession $session -Headers $mgr -ContentType 'application/json' `
  -Body (@{ decision = 'APPROVE' } | ConvertTo-Json)

$resolved | Select-Object state, @{n='outcome';e={$_.resolution.outcome}},
  @{n='by';e={$_.resolution.resolvedBy.displayName}},
  @{n='at';e={$_.resolution.resolvedAt}},
  @{n='policy';e={$_.expense.decision}}, @{n='status';e={$_.expense.status}}
```

| | |
|---|---|
| **Expected HTTP** | **200**, not 201 - this transitions a review, it does not create one |
| **Expected** | `RESOLVED` · `APPROVED` · the manager's name · `expense.decision REVIEW` · `expense.status APPROVED` |
| **Observed** | `200` · `RESOLVED` · `APPROVED` · `Nour Hassan` · `REVIEW` / `APPROVED` |

---

## 6-7. It leaves the list; the expense is final

```powershell
$after = Invoke-RestMethod "$api/v1/reviews" -WebSession $session -Headers $mgr
$after.items.id -contains $review.id        # expect: False

(Invoke-RestMethod "$api/v1/reviews/$($review.id)" -WebSession $session -Headers $mgr).state
```

| | |
|---|---|
| **Expected** | gone from the default (OPEN) listing; still readable by id, now `RESOLVED` |
| **Observed** | `False`, then `RESOLVED` |

---

## 8. Resolve it again

```powershell
# Same manager, SAME decision - the narrow retry exemption.
Invoke-WebRequest "$api/v1/reviews/$($review.id)/resolve" -Method Post `
  -WebSession $session -Headers $mgr -ContentType 'application/json' `
  -Body (@{ decision = 'APPROVE' } | ConvertTo-Json) | Select-Object StatusCode

# Same manager, DIFFERENT decision.
try {
  Invoke-WebRequest "$api/v1/reviews/$($review.id)/resolve" -Method Post `
    -WebSession $session -Headers $mgr -ContentType 'application/json' `
    -Body (@{ decision = 'REJECT' } | ConvertTo-Json)
} catch {
  $_.Exception.Response.StatusCode.value__
  ($_.ErrorDetails.Message | ConvertFrom-Json).error
}
```

| Attempt | Expected | Observed |
|---|---|---|
| Same manager, same decision | **200**, the stored resolution, **zero writes** | `200` |
| Same manager, different decision | **409** `review_already_resolved` | `409` |

The 200 is ADR-004's retry exemption. It exists for a lost response, and it
mutates nothing - verify by checking `updatedAt` in section 14.

---

## 9. Create another review and reject it

```powershell
$body2 = @{
  externalId = "$run-b"; employeeId = "emp2-$run"; amount = 70000
  currency = 'SAR'; merchant = 'Shop'; category = 'TRANSPORT'; spentAt = $ts
} | ConvertTo-Json

$e2 = Invoke-RestMethod "$api/v1/expenses" -Method Post `
  -Headers @{ 'x-api-key' = $key } -ContentType 'application/json' -Body $body2

$r2 = (Invoke-RestMethod "$api/v1/reviews" -WebSession $session -Headers $mgr).items |
      Where-Object { $_.expense.externalId -eq "$run-b" }

Invoke-RestMethod "$api/v1/reviews/$($r2.id)/resolve" -Method Post `
  -WebSession $session -Headers $mgr -ContentType 'application/json' `
  -Body (@{ decision = 'REJECT' } | ConvertTo-Json) |
  Select-Object @{n='outcome';e={$_.resolution.outcome}}, @{n='status';e={$_.expense.status}}
```

**Expected and observed:** `REJECTED` / `REJECTED`, and **no review row is
created for a REJECT** - this one existed because the policy said REVIEW.

---

## 10. Cross-tenant access

```powershell
$foreign = docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -t -A -c `
  "SELECT r.id FROM reviews r JOIN companies c ON c.id=r.""companyId"" WHERE c.name='Delta Consulting' LIMIT 1;"

foreach ($method in 'GET','POST') {
  try {
    if ($method -eq 'GET') {
      Invoke-WebRequest "$api/v1/reviews/$foreign" -WebSession $session -Headers $mgr
    } else {
      Invoke-WebRequest "$api/v1/reviews/$foreign/resolve" -Method Post -WebSession $session `
        -Headers $mgr -ContentType 'application/json' -Body (@{ decision = 'APPROVE' } | ConvertTo-Json)
    }
  } catch { "$method -> $($_.Exception.Response.StatusCode.value__)" }
}
```

| | |
|---|---|
| **Expected** | **404** for both - identical to an id that does not exist |
| **Observed** | `GET -> 404`, `POST -> 404` |

Not 403. A 403 would confirm the review exists, letting a caller walk ids and
learn how many reviews a competitor has (ADR-003).

---

## 11. Resolve with an API key

```powershell
try {
  Invoke-WebRequest "$api/v1/reviews/$($r2.id)/resolve" -Method Post `
    -Headers @{ 'x-api-key' = $key } -ContentType 'application/json' `
    -Body (@{ decision = 'APPROVE' } | ConvertTo-Json)
} catch {
  $_.Exception.Response.StatusCode.value__
  ($_.ErrorDetails.Message | ConvertFrom-Json).error
}
```

| | |
|---|---|
| **Expected** | **403** `caller_type_not_allowed` |
| **Observed** | exactly that |

A key authenticates a company's backend. Reviewing is something a **person**
is accountable for.

---

## 12. Competing managers - a smoke test, not evidence

```powershell
$body3 = @{
  externalId = "$run-c"; employeeId = "emp3-$run"; amount = 80000
  currency = 'SAR'; merchant = 'Shop'; category = 'TRANSPORT'; spentAt = $ts
} | ConvertTo-Json
Invoke-RestMethod "$api/v1/expenses" -Method Post -Headers @{ 'x-api-key' = $key } `
  -ContentType 'application/json' -Body $body3 | Out-Null

$r3 = (Invoke-RestMethod "$api/v1/reviews" -WebSession $session -Headers $mgr).items |
      Where-Object { $_.expense.externalId -eq "$run-c" }

# Two requests from the same session with OPPOSITE decisions.
$jobs = 'APPROVE','REJECT' | ForEach-Object {
  Start-ThreadJob -ArgumentList $api, $r3.id, $_, $email, $password {
    param($api, $id, $decision, $email, $password)
    $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $h = @{ 'x-limaz-client' = '1'; 'origin' = 'http://localhost:3000' }
    Invoke-RestMethod "$api/v1/auth/login" -Method Post -WebSession $s -Headers $h `
      -ContentType 'application/json' `
      -Body (@{ email = $email; password = $password } | ConvertTo-Json) | Out-Null
    try {
      (Invoke-WebRequest "$api/v1/reviews/$id/resolve" -Method Post -WebSession $s `
        -Headers $h -ContentType 'application/json' `
        -Body (@{ decision = $decision } | ConvertTo-Json)).StatusCode
    } catch { $_.Exception.Response.StatusCode.value__ }
  }
}
$jobs | Wait-Job | Receive-Job
```

| | |
|---|---|
| **Expected** | one `200` and one `409`, or two `200`s if both carried the same decision from the same manager |
| **Expected database** | **exactly one** transition; one reviewer; one timestamp |

**Read this as a smoke test.** `Start-ThreadJob` gives no control over
whether the two requests genuinely overlap inside PostgreSQL. The
deterministic evidence is F05-T31 to T38, which hold requests at a barrier
before the UPDATE and confirm the loser is really blocked by polling
`pg_blocking_pids()`, plus F05-NC1 which shows the lost update appearing once
the `state = 'OPEN'` predicate is removed.

---

## 13. Resubmit the expense after resolution

```powershell
Invoke-RestMethod "$api/v1/expenses" -Method Post -Headers @{ 'x-api-key' = $key } `
  -ContentType 'application/json' -Body $body2 |
  Select-Object duplicate, decision, status, id
```

| | |
|---|---|
| **Expected** | `200` · `duplicate true` · `decision REVIEW` · `status REJECTED` · the same id |
| **Database** | one expense, one review, still `RESOLVED` - nothing reopened |
| **Observed** | exactly that |

Both facts in one response: the policy said REVIEW, the human said REJECT.

---

## 14. Inspect what was persisted

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "SELECT e.""externalId"", e.decision AS policy, e.status AS final,
          r.state, r.outcome, u.""displayName"" AS resolved_by,
          (r.""resolvedAt"" IS NOT NULL) AS has_ts,
          (r.""resolvedAt"" = r.""updatedAt"") AS ts_consistent,
          (SELECT count(*) FROM rule_hits rh WHERE rh.""expenseId""=e.id) AS reasons
     FROM expenses e JOIN reviews r ON r.""expenseId""=e.id
     LEFT JOIN users u ON u.id=r.""resolvedByUserId""
    WHERE e.""employeeId"" LIKE '%$run%' ORDER BY e.""createdAt"";"
```

Observed:

```
  externalId   | policy |  final   |  state   | outcome  | resolved_by | has_ts | ts_consistent | reasons
---------------+--------+----------+----------+----------+-------------+--------+---------------+---------
 run…-a        | REVIEW | APPROVED | RESOLVED | APPROVED | Nour Hassan | t      | t             |       1
 run…-b        | REVIEW | REJECTED | RESOLVED | REJECTED | Nour Hassan | t      | t             |       1
```

What to check:

| Column | Invariant |
|---|---|
| `policy` | **Always `REVIEW`.** Human resolution never rewrites it |
| `final` | Matches the manager's decision |
| `ts_consistent` | `resolvedAt = updatedAt` - both written from one `clock_timestamp()` evaluation |
| `reasons` | Unchanged by resolution |

A half-resolved review is impossible:

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "SELECT count(*) FROM reviews
    WHERE (state='RESOLVED' AND (outcome IS NULL OR ""resolvedByUserId"" IS NULL))
       OR (state='OPEN' AND outcome IS NOT NULL);"
```

Expect `0`. The CHECK constraint makes anything else unstorable.

---

## Cleaning up

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "DELETE FROM reviews WHERE ""expenseId"" IN
     (SELECT id FROM expenses WHERE ""employeeId"" LIKE '%$run%');
   DELETE FROM expenses WHERE ""employeeId"" LIKE '%$run%';"
```

Reviews first - `Review -> Expense` is `onDelete: Restrict`. Rule hits
cascade. Or simply start a new `$run`.
