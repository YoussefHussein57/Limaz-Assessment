import { z } from 'zod';
import { MAX_CURSOR_LENGTH } from '../../common/keyset';

/**
 * Listing input for the review endpoints.
 *
 * The cursor itself - how it is built, why it is a pair, and why offset
 * pagination is wrong here - lives in `common/keyset.ts`, shared with the
 * expense listing F06 added. It moved there rather than being copied, because
 * two implementations of a cursor format is two chances to encode one and
 * decode the other.
 *
 * The REASON offset fails differs between the two listings and is worth
 * keeping straight: the OPEN review set SHRINKS under the reader and drops
 * rows, while the expense set GROWS at the head and repeats them. Both are
 * documented at the top of `common/keyset.ts`.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

export const listReviewsSchema = z
  .object({
    /** Defaults to OPEN: the set a manager actually has work in. */
    state: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
    limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(MAX_PAGE_SIZE, `limit must be ${MAX_PAGE_SIZE} or fewer`)
      .default(DEFAULT_PAGE_SIZE),
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  })
  .strict();

export type ListReviewsDto = z.infer<typeof listReviewsSchema>;
