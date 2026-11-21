import { apiGet, apiSend, queryString } from './api-client';
import type {
  ApiKeySummary,
  CompanyDetail,
  CompanyPage,
  CreateCompanyInput,
  CreateCompanyResult,
  CreateManagerInput,
  IssuedApiKey,
  ManagerSummary,
} from './admin-types';

/**
 * Keys and fetchers for platform administration.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 * There is no query key for an issued secret, and there never will be. The
 * three operations that mint one - create a company, issue a key, rotate a key
 * - are MUTATIONS, and their result is held in component state for as long as
 * the dialog showing it is open.
 *
 * A query key would mean the plaintext sits in a cache that survives
 * navigation, gets garbage-collected on its own schedule, and is serialised
 * by any devtools or error reporter that walks the cache. None of that is
 * acceptable for a credential that is displayed once.
 */

export const adminKeys = {
  all: ['admin'] as const,
  companies: () => [...adminKeys.all, 'companies'] as const,
  companyList: (search: string, cursor: string | null) =>
    [...adminKeys.companies(), 'list', search, cursor] as const,
  company: (id: string) => [...adminKeys.companies(), 'detail', id] as const,
  apiKeys: (companyId: string) => [...adminKeys.companies(), 'api-keys', companyId] as const,
  managers: (companyId: string) => [...adminKeys.companies(), 'managers', companyId] as const,
};

export const ADMIN_PAGE_SIZE = 25;

export async function fetchCompanies(
  search: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<CompanyPage> {
  const query = queryString({
    q: search || undefined,
    cursor: cursor ?? undefined,
    limit: ADMIN_PAGE_SIZE,
  });

  return apiGet<CompanyPage>(`/v1/admin/companies${query}`, signal);
}

export async function fetchCompany(companyId: string, signal?: AbortSignal): Promise<CompanyDetail> {
  return apiGet<CompanyDetail>(`/v1/admin/companies/${encodeURIComponent(companyId)}`, signal);
}

export async function fetchApiKeys(
  companyId: string,
  signal?: AbortSignal,
): Promise<{ items: ApiKeySummary[] }> {
  return apiGet<{ items: ApiKeySummary[] }>(
    `/v1/admin/companies/${encodeURIComponent(companyId)}/api-keys`,
    signal,
  );
}

/**
 * Creates a company, its policy and its first API key.
 *
 * The response carries a plaintext secret. Its caller must put it in local
 * state and nowhere else.
 */
export async function createCompany(input: CreateCompanyInput): Promise<CreateCompanyResult> {
  return apiSend<CreateCompanyResult>('POST', '/v1/admin/companies', input);
}

export async function issueApiKey(companyId: string): Promise<IssuedApiKey> {
  return apiSend<IssuedApiKey>(
    'POST',
    `/v1/admin/companies/${encodeURIComponent(companyId)}/api-keys`,
    {},
  );
}

export async function rotateApiKey(companyId: string, keyId: string): Promise<IssuedApiKey> {
  return apiSend<IssuedApiKey>(
    'POST',
    `/v1/admin/companies/${encodeURIComponent(companyId)}/api-keys/${encodeURIComponent(keyId)}/rotate`,
    {},
  );
}

export async function revokeApiKey(companyId: string, keyId: string): Promise<ApiKeySummary> {
  return apiSend<ApiKeySummary>(
    'POST',
    `/v1/admin/companies/${encodeURIComponent(companyId)}/api-keys/${encodeURIComponent(keyId)}/revoke`,
    {},
  );
}

// -----------------------------------------------------------------------------
// Managers (F11)
// -----------------------------------------------------------------------------

export async function fetchManagers(
  companyId: string,
  signal?: AbortSignal,
): Promise<{ items: ManagerSummary[] }> {
  return apiGet<{ items: ManagerSummary[] }>(
    `/v1/admin/companies/${encodeURIComponent(companyId)}/managers`,
    signal,
  );
}

/**
 * Creates one manager.
 *
 * The response carries no credential - unlike `createCompany`, `issueApiKey`
 * and `rotateApiKey`, which is why none of the one-time-secret machinery is
 * involved here. The administrator already holds the password they chose.
 */
export async function createManager(
  companyId: string,
  input: CreateManagerInput,
): Promise<ManagerSummary> {
  return apiSend<ManagerSummary>(
    'POST',
    `/v1/admin/companies/${encodeURIComponent(companyId)}/managers`,
    input,
  );
}
