# ADR-003: What a company gets when it asks for another company's record

- **Status:** Accepted, 2026-11-19
- **Assessment question:** 3
- **Implemented in:** F02
- **Related risk:** R-01

## Context

Many companies share one deployment. A caller authenticated as company A may
request a record belonging to company B, either by guessing an id or because it
genuinely holds one (for example, an id leaked through a support ticket).

The question is not whether to refuse. It is **what the refusal reveals**.

## Decision

**`404 Not Found`.** A record belonging to another tenant is indistinguishable
from a record that does not exist.

Enforcement is structural, not conditional. Every query that touches a
company-owned table carries `WHERE company_id = <authenticated company>`. The
row is never loaded, so there is no "found but forbidden" state in the code to
get wrong.

## Rationale

`403 Forbidden` confirms the resource exists. That turns the endpoint into an
**enumeration oracle**: company A can walk an id space and learn which ids are
real, how many records company B has, and roughly when they were created. The
ids themselves leak information even when the contents do not.

`404` leaks nothing. The only thing company A learns is that it cannot see the
record, which it already knew.

The structural part matters as much as the status code. This is the wrong shape:

```ts
const expense = await prisma.expense.findUnique({ where: { id } });
if (expense.companyId !== ctx.companyId) throw new NotFoundException();
```

It loads another tenant's row into memory before deciding, which means every
future code path that forgets the check is a leak, and any logging in between is
a leak too. This is the right shape:

```ts
const expense = await prisma.expense.findFirst({
  where: { id, companyId: ctx.companyId },
});
if (!expense) throw new NotFoundException();
```

## Consequences

- A manager who mistypes an id and a manager probing another tenant get the same
  response. That is intentional; a friendlier message for the first case would
  re-create the oracle for the second.
- `companyId` must be resolvable for every authenticated request before any
  query runs. It comes from the API key record or the session, never from the
  request body, path or query string.
- Request DTOs use `whitelist: true` and `forbidNonWhitelisted: true`, so a
  caller-supplied `companyId` is stripped before it can reach a service.

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| A query omits the `companyId` filter | Cross-tenant read | Integration tests attempt every read endpoint with company A's credentials against company B's ids |
| An error message echoes the requested id with detail | Partial oracle | A single generic `404` body, identical in both cases |
| A log line records the other tenant's row | Leak at rest | The row is never loaded, so there is nothing to log |

## Test strategy

- Integration: authenticate as company A, request each of company B's record
  types by its real id, assert `404` for every one.
- Integration: assert the body is byte-identical to the body for a
  genuinely nonexistent id.
- Integration: submit a body containing `companyId` for another tenant and
  assert the created record belongs to the authenticated company.
- Integration: unauthenticated requests get `401`, and a manager calling a
  platform-admin endpoint gets `403` (role, not tenancy - different question).
