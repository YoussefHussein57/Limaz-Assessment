# F03 manual test cycle

PowerShell 7 on Windows, against the Docker stack.

## Read this first

`POST /v1/expenses` **is not registered in the running application.**
`ExpensesModule` is wired only inside test modules until F04 binds a real
policy evaluator, so every request below returns `404` today.

That is deliberate, not an oversight: an endpoint that answers `APPROVE`
without evaluating the frequency rule would be wrong in the direction that
approves spending the policy says to review.

| Label | Meaning |
|---|---|
| **RUNS TODAY** | Works against the current stack |
| **NEEDS F04** | Returns `404` until `ExpensesModule` is registered |

Everything marked **NEEDS F04** is covered right now by an automated test
against real PostgreSQL - the id is given so the evidence can be checked.

## Setup - RUNS TODAY

```powershell
docker compose up -d
docker compose ps
```

All three services must read `healthy`.

```powershell
$api   = 'http://localhost:3000/api'
$nile  = '<the Nile Logistics key from the README>'
$delta = '<the Delta Consulting key from the README>'
```

The keys are development-only, seeded, and valid nowhere else. They are
published in **one** place - the *Development credentials* table in the
README - and deliberately not repeated here. Two copies means two things to
change when the seed changes, and one of them gets missed.

The seed also prints them at startup:

```powershell
docker compose logs api | Select-String 'lmz_dev_'
```

Confirm the stack and the keys first:

```powershell
Invoke-RestMethod "$api/v1/auth/me" -Headers @{ 'x-api-key' = $nile }
```

Expected: `callerType: api-key`, `company.name: Nile Logistics`, `user: null`.

**This is the check that matters before any of the rest.** If it fails, the
problem is the stack, not the expense endpoint.

---

## 1. A successful submission - NEEDS F04

**Precondition:** the stack is healthy, `exp-1001` is unused for Nile.

```powershell
$body = @{
  externalId = 'exp-1001'
  employeeId = 'emp-7'
  amount     = 12500
  currency   = 'SAR'
  merchant   = 'City Taxi'
  category   = 'TRANSPORT'
  spentAt    = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
} | ConvertTo-Json

Invoke-WebRequest "$api/v1/expenses" -Method Post `
  -Headers @{ 'x-api-key' = $nile; 'content-type' = 'application/json' } `
  -Body $body | Select-Object StatusCode, Content
```

| | |
|---|---|
| **Expected HTTP** | `201` |
| **Expected body** | `duplicate: false`, `amountMinor: 12500`, a `decision` and a `reasons` array |
| **Expected database** | Exactly one row, `companyId` = Nile, `payloadHash` 64 hex characters, `policySnapshot` populated |
| **Today** | `404` |
| **Automated evidence** | F03-T01, F03-T01b |

`amount` is **minor units**: 12500 is 125.00 SAR. There is no decimal field
anywhere in this API.

---

## 2. Repeating the identical request - NEEDS F04

```powershell
Invoke-WebRequest "$api/v1/expenses" -Method Post `
  -Headers @{ 'x-api-key' = $nile; 'content-type' = 'application/json' } `
  -Body $body | Select-Object StatusCode, Content
```

| | |
|---|---|
| **Expected HTTP** | `200`, not `201` |
| **Expected body** | The **same** `id`, the **same** `decision`, `duplicate: true` |
| **Expected database** | Still exactly one row; no second rule hit, no second review |
| **Today** | `404` |
| **Automated evidence** | F03-T13, F03-T13b, F03-T13c, F03-T23 |

The sharp check is **F03-T13b**: the policy is not re-evaluated. A retry that
re-evaluated would count toward a future frequency window and would change its
answer the moment the policy changed.

Try it with the keys reordered and the currency lowercased - still `200`,
still one row (F03-T13d).

---

## 3. Changing the amount, keeping the externalId - NEEDS F04

```powershell
$conflict = $body | ConvertFrom-Json
$conflict.amount = 99900
$conflictJson = $conflict | ConvertTo-Json

try {
  Invoke-WebRequest "$api/v1/expenses" -Method Post `
    -Headers @{ 'x-api-key' = $nile; 'content-type' = 'application/json' } `
    -Body $conflictJson
} catch {
  $_.Exception.Response.StatusCode.value__
  $_.ErrorDetails.Message
}
```

| | |
|---|---|
| **Expected HTTP** | `409` |
| **Expected body** | `error: conflict`, `details.conflictingField: externalId`, `details.existing` with the original `id`, `decision` and `status`. **No payload hash anywhere** |
| **Expected database** | The row still holds `amountMinor: 12500`. Not 99900 |
| **Today** | `404` |
| **Automated evidence** | F03-T14, F03-T14b, F03-T14c, F03-T14d |

To correct an expense, submit a **new** `externalId`. Overwriting would change
a decision that has already been reported to the caller, and would invalidate
any review opened against it.

---

## 4. Invalid data - NEEDS F04

```powershell
$cases = @(
  @{ name = 'decimal amount';   patch = @{ amount = 125.5 } }
  @{ name = 'negative amount';  patch = @{ amount = -1 } }
  @{ name = 'int4 overflow';    patch = @{ amount = 2147483648 } }
  @{ name = 'wrong currency';   patch = @{ currency = 'USD' } }
  @{ name = 'impossible date';  patch = @{ spentAt = '2026-02-30T09:15:00Z' } }
  @{ name = 'too old';          patch = @{ spentAt = '2020-01-01T09:15:00Z' } }
  @{ name = 'untrimmed id';     patch = @{ externalId = 'exp-1002 ' } }
  @{ name = 'unknown field';    patch = @{ companyId = 'anything' } }
)

foreach ($c in $cases) {
  $b = $body | ConvertFrom-Json
  $c.patch.GetEnumerator() | ForEach-Object {
    $b | Add-Member -NotePropertyName $_.Key -NotePropertyValue $_.Value -Force
  }
  $b.externalId = "manual-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  if ($c.patch.ContainsKey('externalId')) { $b.externalId = $c.patch['externalId'] }

  try {
    $r = Invoke-WebRequest "$api/v1/expenses" -Method Post `
      -Headers @{ 'x-api-key' = $nile; 'content-type' = 'application/json' } `
      -Body ($b | ConvertTo-Json)
    "{0,-18} {1}" -f $c.name, $r.StatusCode
  } catch {
    "{0,-18} {1}" -f $c.name, $_.Exception.Response.StatusCode.value__
  }
}
```

| Case | Expected | Why that code | Evidence |
|---|---|---|---|
| decimal amount | **400** | Shape. Rounding would change the value of money | F03-T05 |
| negative amount | **400** | Shape | F03-T04 |
| int4 overflow | **400** | Shape, caught before the database would reject it | F03-T06 |
| wrong currency | **422** | Business (A3). The request is well formed; the content is not acceptable to *this* company | F03-T09 |
| impossible date | **400** | Shape. `Date.parse` would silently return 2 March | F03-T07 |
| too old | **422** | Business (A4) | F03-T08 |
| untrimmed id | **400** | Trimming would merge two caller identities | validation suite |
| unknown field | **400** | `.strict()`. Ignoring it would leave the caller believing it was honoured | F03-T12 |

**Nothing here produces a 500.** That is the property being checked, as much
as the individual codes.

---

## 5. No API key - RUNS TODAY

The guards are live even though the route is not, so this is genuinely
testable now against any protected route:

```powershell
try { Invoke-WebRequest "$api/v1/expenses" -Method Post -Body '{}' `
        -Headers @{ 'content-type' = 'application/json' } }
catch { $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```

| | |
|---|---|
| **Expected HTTP** | `403`, with `error: csrf_header_required` |
| **Why not 401** | `CsrfGuard` runs **before** authentication, because login is `@Public()` and a later CSRF check would skip it entirely. A POST with neither an API key nor the browser client header is indistinguishable from a cross-site form submission |
| **Evidence** | F03-T10 |

To reach the `401`, shape it as a browser request:

```powershell
try { Invoke-WebRequest "$api/v1/expenses" -Method Post -Body '{}' `
        -Headers @{ 'content-type' = 'application/json'
                    'x-limaz-client' = '1'
                    'origin' = 'http://localhost:3000' } }
catch { $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```

Expected: `401 unauthenticated` (F03-T10a). An unknown key gives the same
`401` with a byte-identical body (F02-T03b).

---

## 6. The same externalId for two companies - NEEDS F04

```powershell
foreach ($key in @($nile, $delta)) {
  $b = $body | ConvertFrom-Json
  $b.externalId = 'exp-shared-2026'
  $r = Invoke-WebRequest "$api/v1/expenses" -Method Post `
    -Headers @{ 'x-api-key' = $key; 'content-type' = 'application/json' } `
    -Body ($b | ConvertTo-Json)
  ($r.Content | ConvertFrom-Json) | Select-Object id, duplicate
}
```

| | |
|---|---|
| **Expected HTTP** | `201` **both times** |
| **Expected body** | Two different `id` values, `duplicate: false` on both |
| **Expected database** | Two rows sharing `externalId`, with different `companyId` |
| **Evidence** | F03-T20, F03-T20b, F03-T20c |

Uniqueness is on `(companyId, externalId)`, not on `externalId`. On
`externalId` alone, one tenant could block identifiers in another and learn
which ones are taken.

---

## 7. Simultaneous submissions - NEEDS F04

```powershell
$shared = $body | ConvertFrom-Json
$shared.externalId = 'exp-race-manual'
$json = $shared | ConvertTo-Json

$jobs = 1..5 | ForEach-Object {
  Start-ThreadJob -ArgumentList $api, $nile, $json {
    param($api, $key, $json)
    try {
      (Invoke-WebRequest "$api/v1/expenses" -Method Post `
        -Headers @{ 'x-api-key' = $key; 'content-type' = 'application/json' } `
        -Body $json).StatusCode
    } catch { $_.Exception.Response.StatusCode.value__ }
  }
}

$jobs | Wait-Job | Receive-Job | Group-Object | Select-Object Name, Count
```

| | |
|---|---|
| **Expected** | One `201`, four `200`. **No `500`, no timeout** |
| **Expected database** | Exactly one row |
| **Evidence** | F03-T17, F03-T18 |

**This manual version is weaker than the automated one, and should be read as
a smoke test rather than proof.** `Start-ThreadJob` gives no control over
whether the requests genuinely overlap inside the database. The automated test
holds the transactions at a barrier inside the evaluator and asserts the
barrier was reached, which is what makes the race real rather than hoped for.

The shape that actually exercises the unique index is **different
`employeeId`, same `externalId`** (F03-T21) - with the same employee the
advisory lock serialises them and the index never fires.

---

## 8. Inspecting the database - RUNS TODAY

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "SELECT e.\"externalId\", c.name, e.\"amountMinor\", e.currency, e.decision, e.status, left(e.\"payloadHash\", 12) AS hash FROM expenses e JOIN companies c ON c.id = e.\"companyId\" ORDER BY e.\"createdAt\" DESC LIMIT 10;"
```

Check that uniqueness really is per tenant:

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'expenses';"
```

`expenses_companyId_externalId_key` appears here as a **unique index**. It is
deliberately absent from `pg_constraint` - Prisma's `@@unique` emits
`CREATE UNIQUE INDEX`, not `ADD CONSTRAINT`. The guarantee is identical; only
the DDL and the catalogue differ.

Find duplicates, which should always return nothing:

```powershell
docker exec limaz-expense-policy-db-1 psql -U limaz -d limaz -c `
  "SELECT \"companyId\", \"externalId\", count(*) FROM expenses GROUP BY 1, 2 HAVING count(*) > 1;"
```

| | |
|---|---|
| **Expected** | `(0 rows)` |
| **If it is not** | The uniqueness guarantee has been lost, and the index cannot be rebuilt until the duplicates are removed - PostgreSQL refuses with `23505 could not create unique index` |

---

## What this cycle cannot show today

| Behaviour | Why | Covered by |
|---|---|---|
| Any decision or reason | F04 computes them | - |
| The 200 / 409 split | The route is unregistered | F03-T13, F03-T14 |
| The aborted-transaction recovery | Needs two overlapping transactions, which `Start-ThreadJob` cannot guarantee | F03-T21, F03-T27 |
| That removing the index breaks it | Destructive; isolated test database only | F03-T27 |

**Rerun sections 1, 2, 3, 4, 6 and 7 after F04** registers the module. The
expected results above do not change; only the `404` does.
