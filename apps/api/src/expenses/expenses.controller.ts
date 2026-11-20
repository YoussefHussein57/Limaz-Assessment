import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { AllowCallerTypes, CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal.types';
import { tenantScope } from '../common/tenant';
import { assertUuid } from '../common/uuid';
import { listExpensesSchema } from './dto/list-expenses.dto';
import { submitExpenseSchema } from './dto/submit-expense.dto';
import { ExpenseQueryService } from './expense-query.service';
import { ExpenseSubmissionService, invalidRequest } from './expense-submission.service';
import type { ExpenseDetail, ExpensePage } from './expense-read.types';
import { toExpenseResponse, type ExpenseResponse } from './expense.types';

/**
 * Expenses: written by a company's backend, read by that company's managers.
 *
 * ---------------------------------------------------------------------------
 * ONE ROUTE NAMESPACE, TWO KINDS OF CALLER
 * ---------------------------------------------------------------------------
 *
 * `POST /v1/expenses` and `GET /v1/expenses` share a path and accept
 * DISJOINT callers. That is enforced per METHOD, and it works because
 * `AuthorizationGuard` reads its metadata with
 *
 *     reflector.getAllAndOverride(KEY, [context.getHandler(), context.getClass()])
 *
 * which takes the handler's value first. So there is deliberately no
 * class-level decorator here - unlike `ReviewsController`, where every route
 * has the same answer:
 *
 *   POST  @AllowCallerTypes('api-key')  a session is refused 403
 *                                       `caller_type_not_allowed`
 *   GET   @Roles('MANAGER')             an API key is refused 403
 *                                       `caller_type_not_allowed`, and the
 *                                       platform admin 403 `insufficient_role`
 *
 * The API-key refusal on the GET routes is not a second rule: `@Roles`
 * IMPLIES a human caller, because a key has no role. One decorator closes
 * both doors.
 *
 * Why the asymmetry is right: an expense is submitted BY an integration, and
 * a person submitting one through the dashboard would bypass the system their
 * company actually runs. Reading is the opposite - a key has no business
 * browsing a dashboard, and a manager has every business reading their own
 * company's spending.
 */
@Controller('v1/expenses')
export class ExpensesController {
  constructor(
    private readonly submission: ExpenseSubmissionService,
    private readonly queries: ExpenseQueryService,
  ) {}

  /**
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

  /** One page of this company's expenses, newest first by `spentAt`. */
  @Roles('MANAGER')
  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<ExpensePage> {
    const parsed = listExpensesSchema.safeParse(query ?? {});

    if (!parsed.success) {
      throw invalidQuery(parsed.error);
    }

    const { companyId } = tenantScope(principal);

    return this.queries.list(companyId, parsed.data);
  }

  /** One expense with every reason, the policy snapshot and the review. */
  @Roles('MANAGER')
  @Get(':expenseId')
  async findOne(
    @CurrentPrincipal() principal: Principal,
    @Param('expenseId') expenseId: string,
  ): Promise<ExpenseDetail> {
    const { companyId } = tenantScope(principal);

    assertUuid(expenseId, 'expenseId');

    return this.queries.findOne(companyId, expenseId);
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

function invalidQuery(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    message: describe(error),
  });
}
