import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decodeCursor, encodeCursor } from '../common/keyset';
import { type ListReviewsDto } from './dto/list-reviews.dto';
import {
  toReviewDetail,
  toReviewSummary,
  type ReviewDetail,
  type ReviewPage,
} from './review.types';

/**
 * Reading reviews, always scoped to the authenticated company.
 *
 * `companyId` goes into the `where` of the query itself, never into a check
 * performed after fetching a global row. The difference is not stylistic: a
 * post-fetch check has already read another tenant's data into this process,
 * and one early return or one refactor away from leaking it.
 */
@Injectable()
export class ReviewQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of reviews, newest first.
   *
   * The relation data is loaded with `include`. That does NOT necessarily
   * compile to a single SQL statement - Prisma may issue one query per
   * relation level and join in memory - and the claim is not made anywhere.
   * What matters is the property the requirement actually asks for: the
   * number of statements is bounded by the SHAPE of the query, not by the
   * number of rows, so there is no N+1. Measured in
   * `review-query-shape.e2e-spec.ts`, which counts the statements Prisma
   * actually emits for a page of 25.
   */
  async list(companyId: string, query: ListReviewsDto): Promise<ReviewPage> {
    const where: Prisma.ReviewWhereInput = {
      companyId,
      ...(query.state === 'ALL' ? {} : { state: query.state }),
      ...(query.cursor ? { ...keysetBefore(query.cursor) } : {}),
    };

    // One extra row, to learn whether another page exists without a second
    // COUNT query - and without claiming there is a next page when there is
    // not, which is what a naive `items.length === limit` does on an exact
    // multiple.
    const rows = await this.prisma.review.findMany({
      where,
      include: {
        expense: { include: { ruleHits: true } },
        resolvedBy: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toReviewSummary),
      nextCursor: hasMore && last ? encodeCursor({ timestamp: last.createdAt, id: last.id }) : null,
    };
  }

  /**
   * One review, or 404.
   *
   * A review belonging to another company answers 404, not 403 (ADR-003).
   * 403 at row level confirms the row exists, which turns the endpoint into
   * an enumeration oracle: a caller could walk ids and learn how many reviews
   * a competitor has. The tenant predicate is in the query, so "not yours"
   * and "not there" are genuinely the same code path rather than two paths
   * that produce the same text.
   */
  async findOne(companyId: string, reviewId: string): Promise<ReviewDetail> {
    const row = await this.prisma.review.findFirst({
      where: { id: reviewId, companyId },
      include: {
        expense: { include: { ruleHits: true } },
        resolvedBy: true,
      },
    });

    if (!row) {
      throw new NotFoundException({
        error: 'not_found',
        message: 'No such review.',
      });
    }

    return toReviewDetail(row);
  }
}

/**
 * `(createdAt, id) < (cursorCreatedAt, cursorId)`, expanded.
 *
 * PostgreSQL supports the row-value form directly, but Prisma's typed API
 * does not, so it is written out: strictly older, OR the same instant with a
 * smaller id. Those two branches are what make the ordering total - without
 * the second, two reviews that share a `createdAt` to the millisecond (the
 * column's full resolution) would be skipped or repeated forever.
 *
 * This compares VALUES. It never looks the cursor row up, so it keeps working
 * after that review is resolved and leaves the OPEN set - which here is the
 * normal case, not an edge case.
 */
function keysetBefore(cursor: string): Prisma.ReviewWhereInput {
  const { timestamp: createdAt, id } = decodeCursor(cursor);

  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
  };
}
