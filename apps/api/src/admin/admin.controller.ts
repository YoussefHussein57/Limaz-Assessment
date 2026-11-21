import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal.types';
import { assertUuid } from '../common/uuid';
import { ApiKeyAdminService } from './api-key-admin.service';
import { CompanyAdminService } from './company-admin.service';
import type { ApiKeySummary, CompanyDetail, CompanyPage, IssuedApiKey } from './admin.types';
import { createCompanySchema, listCompaniesSchema } from './dto/admin.dto';

/**
 * Platform administration.
 *
 * ---------------------------------------------------------------------------
 * THE AUTHORISATION MODEL, STATED ONCE
 * ---------------------------------------------------------------------------
 *
 * `@Roles('PLATFORM_ADMIN')` on the CLASS. Every route here has the same
 * answer, and the guards from F02 give all of it with no new code:
 *
 *   - a company manager is refused 403 `insufficient_role`
 *   - a company API key is refused 403 `caller_type_not_allowed` - @Roles
 *     implies a human caller, because a key has no role
 *   - an unauthenticated caller never reaches here
 *
 * **These routes are deliberately NOT tenant-scoped.** Every other controller
 * derives `companyId` from the session; an administrator has none
 * (`companyId: null` by construction), and their job is to act across
 * companies. So the company id arrives in the PATH.
 *
 * That is safe for exactly one reason, and it is worth stating plainly: the
 * path parameter is a **selector**, applied after the role has already been
 * verified. It is never treated as evidence of anything. An untrusted
 * `companyId` proving authority is the vulnerability this shape could become
 * if the `@Roles` decorator were ever removed - which is why it is on the
 * class rather than repeated per method.
 *
 * CSRF is inherited: `CsrfGuard` runs first on every state-changing request
 * that is not API-key authenticated, so each POST below requires the
 * `x-limaz-client` header and a matching `Origin` (F08-B14).
 */
@Roles('PLATFORM_ADMIN')
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly companies: CompanyAdminService,
    private readonly apiKeys: ApiKeyAdminService,
  ) {}

  @Get('companies')
  async listCompanies(
    @CurrentPrincipal() _principal: Principal,
    @Query() query: unknown,
  ): Promise<CompanyPage> {
    const parsed = listCompaniesSchema.safeParse(query ?? {});

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    return this.companies.list(parsed.data);
  }

  /**
   * Creates a company, its policy and its first API key, atomically.
   *
   * 201, and the body carries the raw key ONCE. That is the only time this
   * system ever returns a plaintext credential outside a rotation.
   *
   * `no-store` because of exactly that. A POST response is already
   * uncacheable by default - a shared cache may only store one when it
   * carries explicit freshness information, which this does not - so the
   * header changes nothing a CORRECT intermediary would do. It is here for
   * the ones that are not, and for the browser's own back/forward cache.
   */
  @Post('companies')
  @Header('Cache-Control', 'no-store')
  async createCompany(
    @Body() body: unknown,
  ): Promise<{ company: CompanyDetail; apiKey: IssuedApiKey }> {
    const parsed = createCompanySchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    return this.companies.create(parsed.data);
  }

  @Get('companies/:companyId')
  async findCompany(@Param('companyId') companyId: string): Promise<CompanyDetail> {
    assertUuid(companyId, 'companyId');

    return this.companies.findOne(companyId);
  }

  @Get('companies/:companyId/api-keys')
  async listApiKeys(
    @Param('companyId') companyId: string,
  ): Promise<{ items: readonly ApiKeySummary[] }> {
    assertUuid(companyId, 'companyId');

    // Wrapped in an object rather than returned as a bare array: a top-level
    // array is a shape that cannot grow a `nextCursor` later without breaking
    // every caller.
    return { items: await this.apiKeys.list(companyId) };
  }

  /** `no-store`: this body carries a plaintext credential. See `createCompany`. */
  @Post('companies/:companyId/api-keys')
  @Header('Cache-Control', 'no-store')
  async issueApiKey(@Param('companyId') companyId: string): Promise<IssuedApiKey> {
    assertUuid(companyId, 'companyId');

    return this.apiKeys.issue(companyId);
  }

  /**
   * 200, not 201. Rotation transitions an existing credential and returns its
   * replacement; calling it a creation would be half true and would make the
   * status code disagree with `revoke` below for no reason.
   *
   * `no-store`: this body carries a plaintext credential, like
   * `createCompany` above.
   */
  @Post('companies/:companyId/api-keys/:keyId/rotate')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  async rotateApiKey(
    @Param('companyId') companyId: string,
    @Param('keyId') keyId: string,
  ): Promise<IssuedApiKey> {
    assertUuid(companyId, 'companyId');
    assertUuid(keyId, 'keyId');

    return this.apiKeys.rotate(companyId, keyId);
  }

  @Post('companies/:companyId/api-keys/:keyId/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeApiKey(
    @Param('companyId') companyId: string,
    @Param('keyId') keyId: string,
  ): Promise<ApiKeySummary> {
    assertUuid(companyId, 'companyId');
    assertUuid(keyId, 'keyId');

    return this.apiKeys.revoke(companyId, keyId);
  }
}

function invalidRequest(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    message: error.issues
      .map((issue) => {
        const field = issue.path.map(String).join('.');

        return field ? `${field}: ${issue.message}` : issue.message;
      })
      .join('; '),
  });
}
