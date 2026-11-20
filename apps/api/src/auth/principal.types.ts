import type { UserRole } from '@prisma/client';

/**
 * Who is making this request, as resolved from a verified credential.
 *
 * This is a DISCRIMINATED UNION on purpose, not an interface with optional
 * fields. The difference is the whole point:
 *
 *   interface Principal { companyId?: string; role?: UserRole }
 *
 * would compile for `principal.companyId!` everywhere, and tenant isolation
 * would depend on nobody writing that `!`. With the union below, a platform
 * admin's `companyId` is typed `null`, so the compiler forces every call site
 * to decide what happens when there is no tenant.
 *
 * Nothing here ever comes from the request body, a query parameter, or a
 * caller-supplied header. An api-key principal's company comes from the row
 * the key hash matched; a user principal's company comes from the user row the
 * session pointed at.
 */

/** A company backend authenticated with an API key. Not a person. */
export interface ApiKeyPrincipal {
  readonly kind: 'api-key';
  readonly apiKeyId: string;
  readonly companyId: string;
}

/** A manager. Always belongs to exactly one company. */
export interface ManagerPrincipal {
  readonly kind: 'user';
  readonly role: Extract<UserRole, 'MANAGER'>;
  readonly userId: string;
  readonly sessionId: string;
  readonly companyId: string;
}

/**
 * The platform admin. Belongs to NO company, which is why companyId is `null`
 * rather than absent - an absent field invites `?.` and a silent undefined; an
 * explicit null forces a decision.
 */
export interface PlatformAdminPrincipal {
  readonly kind: 'user';
  readonly role: Extract<UserRole, 'PLATFORM_ADMIN'>;
  readonly userId: string;
  readonly sessionId: string;
  readonly companyId: null;
}

export type UserPrincipal = ManagerPrincipal | PlatformAdminPrincipal;
export type Principal = ApiKeyPrincipal | UserPrincipal;

/** What kind of caller a route accepts. */
export type CallerType = 'api-key' | 'user';

export function isUserPrincipal(principal: Principal): principal is UserPrincipal {
  return principal.kind === 'user';
}

export function isApiKeyPrincipal(principal: Principal): principal is ApiKeyPrincipal {
  return principal.kind === 'api-key';
}

/**
 * The property the authentication guard attaches the principal to.
 *
 * A symbol rather than a string key: a request body cannot contain a symbol,
 * so there is no shape of incoming JSON that could collide with it and no way
 * for a caller to pre-populate the field we are about to trust.
 */
export const PRINCIPAL = Symbol('limaz.principal');

export interface AuthenticatedRequest {
  [PRINCIPAL]?: Principal;
}
