import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const REQUIRED_ROLES = 'limaz:roles';

/**
 * Restricts a route to specific user roles.
 *
 * Implies a user caller: an API key has no role, so a route carrying this
 * decorator rejects API keys even without @AllowCallerTypes('user').
 *
 * This is ROLE-level authorization and it answers with 403. Whether a
 * particular ROW belongs to the caller's company is a different question,
 * answered with 404 - see tenantScope() and ADR-003.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);
