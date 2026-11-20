import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { AllowCallerTypes, CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal.types';
import { tenantScope } from '../common/tenant';
import { submitExpenseSchema } from './dto/submit-expense.dto';
import { ExpenseSubmissionService, invalidRequest } from './expense-submission.service';
import { toExpenseResponse, type ExpenseResponse } from './expense.types';

/**
 * Expense submission.
 *
 * NOT REGISTERED IN THE DEPLOYED APPLICATION until F04 binds a real policy
 * evaluator - see policy-evaluator.port.ts. `ExpensesModule` is imported only
 * by test modules, exactly as `ProbeController` was in F02, so no route it
 * declares exists in production and no expense can be created without a
 * genuinely evaluated decision.
 */
@Controller('v1/expenses')
export class ExpensesController {
  constructor(private readonly submission: ExpenseSubmissionService) {}

  /**
   * `@AllowCallerTypes('api-key')` is a real restriction, not documentation.
   *
   * A manager's session is a valid credential for the wrong kind of actor: an
   * expense is submitted BY a company's backend, and a person submitting one
   * through the dashboard would bypass the integration their company actually
   * runs. A session reaching here gets 403 (test F03-T11).
   *
   * `@Res({ passthrough: true })` because the status depends on the outcome:
   * 201 for a new expense, 200 for a replay of one that already existed. Both
   * carry the same body, so a caller that only reads the body still knows.
   */
  @AllowCallerTypes('api-key')
  @Post()
  async submit(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<ExpenseResponse> {
    const parsed = submitExpenseSchema.safeParse(body);

    if (!parsed.success) {
      // Field-level messages: unlike login, naming the bad field here reveals
      // nothing - the caller already holds this company's API key and is
      // describing data they supplied themselves.
      throw invalidRequest(describe(parsed.error));
    }

    // The tenant comes from the verified credential and from nowhere else.
    // `.strict()` on the DTO already refuses a body carrying `companyId`, so
    // there is no request shape in which a caller could name another company
    // (tests F03-T12, F03-T20).
    const { companyId } = tenantScope(principal);

    const result = await this.submission.submit(companyId, parsed.data);

    response.statusCode = result.duplicate ? HttpStatus.OK : HttpStatus.CREATED;

    return toExpenseResponse(result.expense, result.ruleHits, result.duplicate);
  }
}

/** Flattens Zod issues into one readable line, newest API (`error.issues`). */
function describe(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.map(String).join('.');

      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
