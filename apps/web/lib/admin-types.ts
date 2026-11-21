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

/**
 * A company manager, as the administrator sees them (F11).
 *
 * There is no password and no hash in this shape, and the API never sends
 * one. There is also no "last signed in" and no account status, because
 * neither is recorded anywhere in this system - showing an invented one would
 * be a fabricated metric.
 */
export interface ManagerSummary {
  id: string;
  email: string;
  displayName: string;
  role: 'MANAGER';
  createdAt: string;
}

export interface CreateManagerInput {
  displayName: string;
  email: string;
  /**
   * The initial password the administrator chose.
   *
   * It travels in the request body, over the same same-origin proxy every
   * other mutation uses, and it is NOT echoed back in the response. The form
   * clears it on success so it does not sit in React state behind a closed
   * dialog.
   */
  password: string;
}
