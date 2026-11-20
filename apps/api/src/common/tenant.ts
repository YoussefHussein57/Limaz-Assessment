import { ForbiddenException } from '@nestjs/common';
import type { Principal } from '../auth/principal.types';

/**
 * The single place a tenant filter is derived from.
 *
 * Every query against a company-owned table spreads the result of this into
 * its `where` clause:
 *
 *   prisma.expense.findFirst({ where: { id, ...tenantScope(principal) } })
 *
 * Two things follow from doing it here rather than inline:
 *
 * 1. `grep tenantScope` finds every tenant-scoped query in the codebase. A
 *    hand-written `companyId: something` does not grep as reliably.
 * 2. The platform-admin case - a principal with no tenant - is handled once,
 *    loudly, instead of being quietly skipped at twenty call sites.
 *
 * This is NOT a repository abstraction. It returns a plain object that goes
 * straight into a Prisma `where`; the query stays visible at the call site.
 *
 * The alternative considered and rejected was PostgreSQL row-level security,
 * which the database would enforce for us. It needs `SET LOCAL` on every
 * transaction, has no Prisma support, is awkward under transaction-mode
 * connection pooling, and would need a BYPASSRLS role for the admin. Recorded
 * in docs/features/F02-authentication.md as the upgrade path. The limitation
 * we accept in exchange is real: a developer CAN forget to spread this into a
 * query. Test F02-T29 is the negative control that proves the tests would
 * notice.
 */
export function tenantScope(principal: Principal): { companyId: string } {
  if (principal.companyId === null) {
    // A platform admin has no tenant of their own. Reaching here means a
    // company-scoped query ran on an admin's behalf without the admin naming
    // the company - which would silently have meant "no rows" or, worse, "all
    // rows". Admin endpoints take an explicit company id instead; that is F08.
    throw new ForbiddenException({
      error: 'tenant_required',
      message: 'This resource is scoped to a company and the caller has none.',
    });
  }

  return { companyId: principal.companyId };
}

/**
 * The tenant, or `null` for a principal that has none.
 *
 * For the few places that genuinely need to branch - `/v1/auth/me` reports a
 * company for a manager and `null` for the platform admin - rather than
 * treating the absence as an error.
 */
export function tenantOf(principal: Principal): string | null {
  return principal.companyId;
}
