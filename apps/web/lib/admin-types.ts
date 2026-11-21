/** The shapes the platform administration endpoints return. */

export type ApiKeyState = 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'REVOKED';

export interface CompanySummary {
  id: string;
  name: string;
  currency: string;
  createdAt: string;
  /** How many of its keys can authenticate right now - not how many exist. */
  activeApiKeys: number;
}

export interface CompanyPage {
  items: CompanySummary[];
  nextCursor: string | null;
}

export interface CompanyDetail extends CompanySummary {
  policy: {
    autoApproveLimitMinor: number;
    frequencyMaxCount: number;
    frequencyWindowMinutes: number;
    blockedCategories: string[];
  } | null;
  /** Zero until somebody is provisioned. See assumption A5 and R-32. */
  managerCount: number;
}

export interface ApiKeySummary {
  id: string;
  /** Display only. It takes no part in authentication (ADR-006). */
  prefix: string;
  state: ApiKeyState;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

/**
 * A newly minted key.
 *
 * The only shape in this application that ever carries a plaintext secret.
 * It is handled by exactly one component and is never written to a query
 * cache, browser storage, a URL or a log.
 */
export interface IssuedApiKey {
  key: ApiKeySummary;
  plaintext: string;
}

export interface CreateCompanyResult {
  company: CompanyDetail;
  apiKey: IssuedApiKey;
}

export interface CreateCompanyInput {
  name: string;
  currency: string;
  autoApproveLimitMinor?: number;
  frequencyMaxCount?: number;
  frequencyWindowMinutes?: number;
  blockedCategories?: string[];
}
