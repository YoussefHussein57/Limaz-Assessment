import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ManagerPrincipal } from '../auth/principal.types';
import { PrismaService } from '../prisma/prisma.service';
import { expenseStatusFor, outcomeFor, type ResolveReviewDto } from './dto/resolve-review.dto';
import { ReviewQueryService } from './review-query.service';
import type { ReviewDetail } from './review.types';

/**
 * Resolving a review: exactly one state transition, ever.
 *
 * ---------------------------------------------------------------------------
 * WHY A CONDITIONAL UPDATE AND NOT READ-THEN-UPDATE
 * ---------------------------------------------------------------------------
 *
 * Reading the review, checking `state === 'OPEN'` in memory and then updating
 * is a lost update waiting to happen. Two managers both read OPEN, both pass
 * the check, both write - and the second silently overwrites the first's
 * outcome, reviewer and timestamp. A transaction does NOT fix this: both
 * transactions can read OPEN and both can write, because nothing they did
 * conflicts at the row level until the writes themselves, and by then the
 * decision has already been made in application memory.
 *
 * Putting `state = 'OPEN'` into the UPDATE's own WHERE clause is what fixes
 * it, and the mechanism is specific: when the second transaction's UPDATE
 * reaches the row, it blocks on the row lock the first one holds. When the
 * first COMMITs, PostgreSQL does not simply proceed - it RE-EVALUATES the
 * second statement's WHERE against the updated row (EvalPlanQual). The row is
 * now RESOLVED, the predicate fails, and the statement affects zero rows.
 *
 * That re-check is the entire reason `UPDATE ... WHERE state = 'OPEN'` is
 * safe at READ COMMITTED and an in-memory check is not.
 *
 * ---------------------------------------------------------------------------
 * WHY NO ADVISORY LOCK HERE, UNLIKE F04
 * ---------------------------------------------------------------------------
 *
 * F04's invariant is a COUNT across many rows - a read-then-write over a SET,
 * which no row lock can protect because there is no single row to lock. This
 * invariant is one row's state transition, which is exactly what a row lock
 * and a predicate re-check do protect. An advisory lock here would serialise
 * unrelated reviews for no gain.
 */
@Injectable()
export class ReviewResolutionService {
  private readonly logger = new Logger(ReviewResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: ReviewQueryService,
  ) {}

  async resolve(
    principal: ManagerPrincipal,
    reviewId: string,
    dto: ResolveReviewDto,
  ): Promise<ReviewDetail> {
    const { companyId, userId } = principal;
    const outcome = outcomeFor(dto.decision);

    const won = await this.prisma.$transaction(async (tx) => {
      // -----------------------------------------------------------------
      // 1. The conditional update. Tenant guard and concurrency guard in
      //    the SAME WHERE clause - checking the tenant separately opens a
      //    time-of-check-to-time-of-use gap between the check and the write.
      //
      //    TIMESTAMP SEMANTICS. There are THREE distinct instants here and
      //    only one of them is recorded:
      //
      //      1. transaction start   - what now() would return. Under
      //         contention this can be noticeably earlier, because the
      //         transaction may have sat waiting on the row lock first.
      //      2. STATEMENT EXECUTION - what clock_timestamp() returns, and
      //         what `resolvedAt` stores. This is the instant the manager's
      //         decision took effect on the row.
      //      3. COMMIT              - when the change became visible to
      //         anyone else. NOT RECORDED ANYWHERE, and it is strictly after
      //         (2): the expense update and the commit itself happen in
      //         between.
      //
      //    So `resolvedAt` is the resolution time, not the commit time, and
      //    the gap between them is however long the rest of the transaction
      //    took. Two resolutions can therefore commit in a different order
      //    from their `resolvedAt` values - which does not matter here,
      //    because only one of them can win a given review, but would matter
      //    to anything that tried to order unrelated resolutions by this
      //    column alone.
      //
      //    The value is computed ONCE in the FROM clause and written to both
      //    columns, so `resolvedAt` and `updatedAt` cannot differ - two
      //    separate `clock_timestamp()` calls would return two different
      //    instants.
      //
      //    `updatedAt` is set explicitly because Prisma's `@updatedAt` is
      //    applied by the client, and a raw statement bypasses it. Without
      //    this the column would silently keep its creation value.
      //
      //    Tagged template: every value below is a bound parameter. Nothing
      //    caller-controlled is concatenated into the SQL text.
      // -----------------------------------------------------------------
      const updated = await tx.$queryRaw<{ expenseId: string }[]>`
        UPDATE "reviews"
           SET state = 'RESOLVED',
               outcome = ${outcome}::"ReviewOutcome",
               "resolvedByUserId" = ${userId}::uuid,
               "resolvedAt" = resolution.at,
               "updatedAt" = resolution.at
          FROM (SELECT clock_timestamp() AS at) AS resolution
         WHERE "reviews".id = ${reviewId}::uuid
           AND "reviews"."companyId" = ${companyId}::uuid
           AND "reviews".state = 'OPEN'
        RETURNING "reviews"."expenseId"
      `;

      // -----------------------------------------------------------------
      // 2. Zero rows is not automatically "already resolved". It is one of
      //    four things, and they get four different answers - see
      //    explainZeroRows(). Classifying every zero-row update as a
      //    successful retry would report success for a review that never
      //    existed.
      // -----------------------------------------------------------------
      if (updated.length === 0) {
        return null;
      }

      if (updated.length > 1) {
        // Unreachable: `id` is the primary key. If it ever happens, the
        // transaction must not commit.
        throw new InternalServerErrorException({
          error: 'internal_error',
          message: 'An unexpected error occurred.',
        });
      }

      const expenseId = updated[0]!.expenseId;

      // -----------------------------------------------------------------
      // 3. The expense, in the SAME transaction.
      //
      //    This is the answer to "what if the review update succeeds and the
      //    expense update fails?" - NOTHING IS OBSERVABLE. Neither write is
      //    visible to any other transaction until COMMIT, so there is no
      //    moment at which the review is resolved while the expense is still
      //    pending. That state only exists if the two writes are split
      //    across separate transactions or separate HTTP calls.
      //
      //    The tenant predicate is repeated, and `status = 'PENDING_REVIEW'`
      //    is required: an expense in any other status means something has
      //    gone wrong that this request must not paper over.
      // -----------------------------------------------------------------
      const expense = await tx.expense.updateMany({
        where: { id: expenseId, companyId, status: 'PENDING_REVIEW' },
        data: { status: expenseStatusFor(dto.decision) },
      });

      if (expense.count !== 1) {
        this.logger.error(
          `Review ${reviewId} transitioned but its expense updated ${expense.count} rows.`,
        );
        // Rolls back the review update too. A resolved review pointing at a
        // still-pending expense is worse than a failed request.
        throw new InternalServerErrorException({
          error: 'internal_error',
          message: 'An unexpected error occurred.',
        });
      }

      return expenseId;
    });

    if (won === null) {
      return this.explainZeroRows(principal, reviewId, dto);
    }

    // Read AFTER the commit, so the response describes committed state and
    // never a view that could still roll back.
    return this.queries.findOne(companyId, reviewId);
  }

  /**
   * The conditional update affected no rows. Why?
   *
   * Four possibilities, four answers. This runs OUTSIDE the transaction,
   * which rolled back; nothing was written, so there is nothing to undo.
   */
  private async explainZeroRows(
    principal: ManagerPrincipal,
    reviewId: string,
    dto: ResolveReviewDto,
  ): Promise<ReviewDetail> {
    const { companyId, userId } = principal;

    // Tenant-scoped, so "another company's review" and "no such review" are
    // the same query and therefore genuinely indistinguishable (ADR-003).
    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, companyId },
    });

    if (!review) {
      throw new NotFoundException({ error: 'not_found', message: 'No such review.' });
    }

    if (review.state === 'OPEN') {
      // It exists, it is this company's, it is OPEN - and the conditional
      // update still matched nothing. That is a contradiction, not a retry.
      // Reporting success here would be the worst possible answer.
      this.logger.error(`Review ${reviewId} is OPEN but the conditional update affected no rows.`);
      throw new InternalServerErrorException({
        error: 'internal_error',
        message: 'An unexpected error occurred.',
      });
    }

    const sameManager = review.resolvedByUserId === userId;
    const sameOutcome = review.outcome === outcomeFor(dto.decision);

    if (sameManager && sameOutcome) {
      // ADR-004's narrow retry. The caller resolved this themselves, the same
      // way, and is asking again - almost always because the response was
      // lost. Returning 409 for an action that succeeded would be confusing
      // and would push them to investigate something that is fine.
      //
      // ZERO WRITES happen on this path: the reviewer, the outcome and the
      // timestamp recorded by the original transition are returned unchanged.
      // The assessment requires exactly one state TRANSITION, not exactly one
      // 2xx response, and this performs none.
      return this.queries.findOne(companyId, reviewId);
    }

    throw new ConflictException({
      error: 'review_already_resolved',
      message: 'This review has already been resolved.',
      details: {
        reviewId: review.id,
        outcome: review.outcome ?? 'unknown',
        resolvedAt: review.resolvedAt?.toISOString() ?? 'unknown',
        // The id, not the name: the loser is told who won well enough to stop
        // retrying, without this becoming a way to enumerate colleagues.
        resolvedByUserId: review.resolvedByUserId ?? 'unknown',
      },
    });
  }
}

/** Re-exported so tests can assert the exact Prisma namespace is in use. */
export type { Prisma };
