import { Controller, Get } from '@nestjs/common';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal.types';
import { tenantScope } from '../common/tenant';
import { DashboardSummaryService } from './dashboard-summary.service';
import type { CategoryList, DashboardSummary } from './summary.types';

/**
 * The manager dashboard's aggregate figures.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE NAMESPACE AND NOT `GET /v1/expenses/summary`
 * ---------------------------------------------------------------------------
 *
 * `/v1/expenses/summary` collides with `/v1/expenses/:expenseId`. Nest
 * resolves that by DECLARATION ORDER, so it works as long as the literal
 * route is declared first - and breaks silently the day somebody reorders the
 * methods, at which point `summary` is parsed as an expense id and answers
 * 400. A separate namespace removes the ambiguity rather than relying on a
 * convention nobody can see from the call site.
 *
 * `@Roles('MANAGER')` does three things here, none of them new code:
 *
 *  - an API key is refused, because @Roles implies a human caller and a key
 *    has no role (403 `caller_type_not_allowed`)
 *  - the platform admin is refused, because they are not a MANAGER
 *    (403 `insufficient_role`). A company's spending figures are that
 *    company's business; F08 gives administrators explicit, company-named
 *    access instead of inheriting it silently
 *  - an unauthenticated caller never reaches here at all
 */
@Roles('MANAGER')
@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly summary: DashboardSummaryService) {}

  @Get('summary')
  async getSummary(@CurrentPrincipal() principal: Principal): Promise<DashboardSummary> {
    // The tenant comes from the verified session and from nowhere else. There
    // is no query parameter that could name a company, and adding one would
    // make the authorization boundary client-controlled.
    const { companyId } = tenantScope(principal);

    return this.summary.summarise(companyId);
  }

  /**
   * Every category this company has used, for the expense filter.
   *
   * Here rather than at `GET /v1/expenses/categories` for the same reason
   * `summary` is here: that path collides with `GET /v1/expenses/:expenseId`
   * and would be resolved by declaration order, which breaks silently the day
   * somebody reorders the methods.
   */
  @Get('expense-categories')
  async getExpenseCategories(@CurrentPrincipal() principal: Principal): Promise<CategoryList> {
    const { companyId } = tenantScope(principal);

    return this.summary.listCategories(companyId);
  }
}
