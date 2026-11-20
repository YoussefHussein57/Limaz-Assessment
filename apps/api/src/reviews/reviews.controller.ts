import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { ManagerPrincipal, Principal } from '../auth/principal.types';
import { tenantScope } from '../common/tenant';
import { listReviewsSchema } from './dto/list-reviews.dto';
import { resolveReviewSchema } from './dto/resolve-review.dto';
import { ReviewQueryService } from './review-query.service';
import { ReviewResolutionService } from './review-resolution.service';
import type { ReviewDetail, ReviewPage } from './review.types';

/**
 * The manager's review endpoints.
 *
 * `@Roles('MANAGER')` on the CLASS, so it covers every route including any
 * added later. It does three things at once, and all three are required:
 *
 *  - an API key is refused, because `@Roles` implies a human caller and a key
 *    has no role (403 `caller_type_not_allowed`)
 *  - the platform admin is refused, because they are not a MANAGER
 *    (403 `insufficient_role`). Reviewing a company's spending is a company's
 *    business, and no existing contract grants an administrator that
 *    authority - so it is denied rather than assumed
 *  - an unauthenticated caller never reaches here at all
 *
 * None of it is new code. The guards from F02 already answer these questions;
 * this decorator is how a route asks them.
 */
@Roles('MANAGER')
@Controller('v1/reviews')
export class ReviewsController {
  constructor(
    private readonly queries: ReviewQueryService,
    private readonly resolution: ReviewResolutionService,
  ) {}

  /** Open reviews for the caller's company, newest first. */
  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<ReviewPage> {
    const parsed = listReviewsSchema.safeParse(query ?? {});

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    const { companyId } = tenantScope(principal);

    return this.queries.list(companyId, parsed.data);
  }

  /** One review with its expense, every reason, and the policy snapshot. */
  @Get(':reviewId')
  async findOne(
    @CurrentPrincipal() principal: Principal,
    @Param('reviewId') reviewId: string,
  ): Promise<ReviewDetail> {
    const { companyId } = tenantScope(principal);

    // A malformed id is a 400 rather than a 500 from PostgreSQL rejecting the
    // uuid cast. It is deliberately NOT a 404: the id is unusable, which is a
    // different fact from "there is no such review", and conflating them
    // would hide a client bug behind a plausible-looking answer.
    assertUuid(reviewId);

    return this.queries.findOne(companyId, reviewId);
  }

  /**
   * Approve or reject an open review.
   *
   * CSRF protection is inherited, not re-implemented: `CsrfGuard` runs first
   * on every state-changing request that is not API-key authenticated, which
   * a manager's session is not. So this route requires the `x-limaz-client`
   * header and a matching `Origin` exactly as login and logout do (F02).
   */
  @Post(':reviewId/resolve')
  // 200, not Nest's default 201 for POST. Resolving does not CREATE anything -
  // it transitions a review that already exists, and the response describes
  // that same review. ADR-004 specifies 200, and the retry contract depends on
  // it: a replayed resolution returns 200 having written nothing, which would
  // be incoherent if the first call had claimed to create a resource.
  @HttpCode(HttpStatus.OK)
  async resolve(
    @CurrentPrincipal() principal: Principal,
    @Param('reviewId') reviewId: string,
    @Body() body: unknown,
  ): Promise<ReviewDetail> {
    // tenantScope throws for a principal with no tenant, so this narrowing is
    // backed by a runtime guarantee rather than an assumption.
    tenantScope(principal);
    assertUuid(reviewId);

    const parsed = resolveReviewSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    return this.resolution.resolve(principal as ManagerPrincipal, reviewId, parsed.data);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function assertUuid(value: string): void {
  if (!UUID.test(value)) {
    throw new BadRequestException({
      error: 'invalid_request',
      message: 'reviewId must be a UUID.',
    });
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
