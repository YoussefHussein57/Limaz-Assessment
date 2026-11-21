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
import { ManagerAdminService } from './manager-admin.service';
import type {
  ApiKeySummary,
  CompanyDetail,
  CompanyPage,
  IssuedApiKey,
  ManagerSummary,
} from './admin.types';
import { createCompanySchema, createManagerSchema, listCompaniesSchema } from './dto/admin.dto';
import type {
  ProvisionedWebhookIntegration,
  WebhookIntegrationState,
} from '../webhooks/webhook-integration.service';
import { WebhookIntegrationService } from '../webhooks/webhook-integration.service';

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
    private readonly managers: ManagerAdminService,
    private readonly webhooks: WebhookIntegrationService,
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

  // ---------------------------------------------------------------------------
  // Card webhook integration (F12)
  //
  // Two routes, and the asymmetry between them is the security story. Reading
  // returns metadata only - a delivery id, a version, two timestamps - and
  // reading it a thousand times reveals nothing. Writing MINTS A SIGNING
  // SECRET and returns it once, which is why it alone carries `no-store`.
  // ---------------------------------------------------------------------------

  @Get('companies/:companyId/webhook-integration')
  async describeWebhookIntegration(
    @Param('companyId') companyId: string,
  ): Promise<WebhookIntegrationState> {
    assertUuid(companyId, 'companyId');

    return this.webhooks.describe(companyId);
  }

  /**
   * Creates the integration, or replaces its signing secret.
   *
   * One route for both, because they are the same operation: mint a secret
   * and store it. A separate "rotate" would differ only in whether a row
   * already existed, which is a detail of this database rather than something
   * the caller should have to know.
   *
   * `no-store`: this is the only response in F12 that carries a plaintext
   * credential, for the same reason the three key routes above do.
   */
  @Post('companies/:companyId/webhook-integration')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  async provisionWebhookIntegration(
    @Param('companyId') companyId: string,
  ): Promise<ProvisionedWebhookIntegration> {
    assertUuid(companyId, 'companyId');

    return this.webhooks.provision(companyId);
  }

  // ---------------------------------------------------------------------------
  // Managers (F11)
  //
  // Same shape as the key routes above and the same security model: the
  // company id is a SELECTOR applied after `@Roles('PLATFORM_ADMIN')` on the
  // class has already established the caller. It is never evidence.
  //
  // What differs is which fields the server refuses to take from the caller.
  // `role` and `companyId` are written by `ManagerAdminService` and are not in
  // `createManagerSchema` at all, so a body carrying either is a 400 from a
  // `.strict()` parse rather than a field somebody downstream has to remember
  // not to spread (F11-T10, F11-T11).
  // ---------------------------------------------------------------------------

  @Get('companies/:companyId/managers')
  async listManagers(
    @Param('companyId') companyId: string,
  ): Promise<{ items: readonly ManagerSummary[] }> {
    assertUuid(companyId, 'companyId');

    // Wrapped, for the same reason the key listing is: a top-level array
    // cannot grow a `nextCursor` later without breaking every caller.
    return { items: await this.managers.list(companyId) };
  }

  /**
   * Creates one manager for this company.
   *
   * 201, and the body carries NO credential. The administrator chose the
   * initial password and already has it; echoing it back would put a secret
   * into a response, a proxy log and a devtools panel for no gain. That is
   * why there is no `no-store` header here - unlike the three routes above,
   * nothing in this response is worth caching protection.
   */
  @Post('companies/:companyId/managers')
  @HttpCode(HttpStatus.CREATED)
  async createManager(
    @Param('companyId') companyId: string,
    @Body() body: unknown,
  ): Promise<ManagerSummary> {
    assertUuid(companyId, 'companyId');

    const parsed = createManagerSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    return this.managers.create(companyId, parsed.data);
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
