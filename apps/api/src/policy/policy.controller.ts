import { BadRequestException, Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal.types';
import { tenantScope } from '../common/tenant';
import { updatePolicySchema } from './dto/update-policy.dto';
import { PolicyService } from './policy.service';
import type { PolicyView } from './policy.types';

/**
 * The company's own policy, read and edited by its manager.
 *
 * `@Roles('MANAGER')` on the class, as on `ReviewsController`: every route
 * here has the same answer. It refuses an API key (a key has no role), the
 * platform admin (not a MANAGER) and an unauthenticated caller, using the
 * guards F02 already ships.
 *
 * **On the platform admin being refused**: a company's spending rules are that
 * company's business, and no approved contract grants an administrator the
 * power to change them. F08 gives administrators company onboarding and
 * credential management - not the authority to decide what another company
 * auto-approves.
 *
 * CSRF is inherited, not re-implemented: `CsrfGuard` runs first on every
 * state-changing request that is not API-key authenticated, so the PATCH
 * requires the `x-limaz-client` header and a matching `Origin` exactly as
 * login does (F02).
 */
@Roles('MANAGER')
@Controller('v1/policy')
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  @Get()
  async find(@CurrentPrincipal() principal: Principal): Promise<PolicyView> {
    const { companyId } = tenantScope(principal);

    return this.policy.find(companyId);
  }

  /**
   * PATCH, not PUT: an absent field is left alone.
   *
   * A PUT would mean "replace the whole policy", so a client sending only the
   * limit would silently clear the blocked-category list - and the company
   * would stop blocking anything without a single error.
   */
  @Patch()
  async update(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<PolicyView> {
    const parsed = updatePolicySchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    // The tenant comes from the verified session. `.strict()` above already
    // refuses a body carrying `companyId`, so there is no request shape in
    // which a manager could name another company (F07-B08).
    const { companyId } = tenantScope(principal);

    return this.policy.update(companyId, parsed.data);
  }
}

function invalidRequest(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    // Field-level messages: the caller is a signed-in manager describing data
    // they supplied themselves, so naming the offending field helps them and
    // reveals nothing - unlike login, which deliberately withholds it.
    message: error.issues
      .map((issue) => {
        const field = issue.path.map(String).join('.');

        return field ? `${field}: ${issue.message}` : issue.message;
      })
      .join('; '),
  });
}
