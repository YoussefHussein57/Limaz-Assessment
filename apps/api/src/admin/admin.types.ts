import type { ApiKey, Company } from '@prisma/client';

/**
 * The shapes the admin endpoints return.
 *
 * Built field by field, and here the rule earns its keep more than anywhere
 * else in the codebase: `ApiKey` carries `keyHash`, and a spread would publish
 * it. A hash is not a usable credential, but it is the exact value an offline
 * attacker needs to confirm a guess, and **no management operation requires
 * returning one**. It is never in any response.
 */

/** What an administrator may see about a company. */
export interface CompanySummary {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly createdAt: string;
  /** How many of its keys can authenticate right now. */
  readonly activeApiKeys: number;
}

export interface CompanyPage {
  readonly items: readonly CompanySummary[];
  readonly nextCursor: string | null;
}

export interface CompanyDetail extends CompanySummary {
  /**
   * The policy, so an administrator can see a company was initialised
   * correctly. **Read only** - editing it is the manager's authority (F07),
   * and no approved contract gives an administrator that power.
   */
  readonly policy: {
    readonly autoApproveLimitMinor: number;
    readonly frequencyMaxCount: number;
    readonly frequencyWindowMinutes: number;
    readonly blockedCategories: readonly string[];
  } | null;
  /** Whether anyone can sign in for this company yet (assumption A5). */
  readonly managerCount: number;
}

/**
 * The lifecycle state a key is actually in.
 *
 * DERIVED, never read from one column. `status` alone would call a key with
 * `status = ROTATING` and a passed `expiresAt` "rotating", when in fact it can
 * no longer authenticate at all. The authentication query is the authority:
 *
 *   status IN (ACTIVE, ROTATING) AND revokedAt IS NULL
 *     AND (expiresAt IS NULL OR expiresAt > now())
 *
 * and `deriveKeyState` is that same logic, in the same order, so the label a
 * reader sees cannot disagree with whether the key works.
 */
export type ApiKeyState = 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'REVOKED';

export interface ApiKeySummary {
  readonly id: string;
  /** Display only - it takes no part in authentication (ADR-006). */
  readonly prefix: string;
  readonly state: ApiKeyState;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * A newly minted key.
 *
 * The ONLY shape in this system that carries a plaintext secret, returned by
 * the only two operations that create one. Everything else returns
 * `ApiKeySummary`, which cannot.
 */
export interface IssuedApiKey {
  readonly key: ApiKeySummary;
  /**
   * The full secret, shown once.
   *
   * It cannot be recovered afterwards: only its SHA-256 hash is stored, and
   * that is the point of storing a hash. If this response is lost, the
   * recovery path is to revoke the key and issue another - not to look it up.
   */
  readonly plaintext: string;
}

export function deriveKeyState(key: Pick<ApiKey, 'status' | 'expiresAt' | 'revokedAt'>): ApiKeyState {
  // Revocation first: it is immediate and overrides everything else.
  if (key.status === 'REVOKED' || key.revokedAt !== null) {
    return 'REVOKED';
  }

  if (key.expiresAt !== null && key.expiresAt.getTime() <= Date.now()) {
    return 'EXPIRED';
  }

  // ROTATING with a future expiry is the 24-hour grace window: superseded,
  // still working, about to stop.
  return key.status === 'ROTATING' ? 'GRACE' : 'ACTIVE';
}

export function toApiKeySummary(key: ApiKey): ApiKeySummary {
  return {
    id: key.id,
    prefix: key.prefix,
    state: deriveKeyState(key),
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

type CompanyRow = Company & { _count: { apiKeys: number } };

export function toCompanySummary(row: CompanyRow, activeApiKeys: number): CompanySummary {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    activeApiKeys,
  };
}
