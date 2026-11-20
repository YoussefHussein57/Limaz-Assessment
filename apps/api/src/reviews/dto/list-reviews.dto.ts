import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Listing input, and the cursor.
 *
 * ---------------------------------------------------------------------------
 * WHY KEYSET AND NOT OFFSET
 * ---------------------------------------------------------------------------
 *
 * The default listing is OPEN reviews, and that set SHRINKS while it is being
 * read - every resolution removes a row. Under offset pagination the rows
 * after it shift up by one, so page 2 begins where page 1 ended minus the
 * resolutions that happened in between, and the manager silently never sees
 * them. Offset is not merely less elegant here; it drops work.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CURSOR IS A PAIR, NOT AN ID
 * ---------------------------------------------------------------------------
 *
 * Two separate reasons, and the first one was initially stated wrongly here:
 *
 * 1. `createdAt` is `Timestamptz(3)` - its resolution is ONE MILLISECOND. Any
 *    bulk insert, import or backfill can produce rows that tie, and a cursor
 *    on `createdAt` alone would then skip or repeat whichever rows share that
 *    instant. (The original claim was that rows created in one transaction
 *    share a `createdAt` because the column defaults to `CURRENT_TIMESTAMP`.
 *    They do not - Prisma supplies the value per row from the client, so the
 *    default never fires. The exposure is real; that explanation of it was
 *    not.)
 *
 * 2. `id` is a UUIDv7, which is approximately time-ordered - and approximately
 *    is not a contract. Its timestamp and `createdAt` come from different
 *    sources and need not agree, so ordering by `id` alone would not match the
 *    `createdAt DESC` the API promises.
 *
 * So the order is `(createdAt DESC, id DESC)` and the cursor carries both,
 * which makes the ordering total however the ties arise.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SURVIVES THE CURSOR ROW DISAPPEARING
 * ---------------------------------------------------------------------------
 *
 * The cursor is compared as a VALUE, not looked up as a row:
 *
 *     WHERE (createdAt, id) < (cursorCreatedAt, cursorId)
 *
 * Prisma's own `cursor` option does a row lookup and would fail - or silently
 * return nothing - once that review is resolved and leaves the OPEN set. This
 * form does not care whether the row still exists, which is the normal case
 * here rather than an edge case.
 *
 * Tenant isolation does not depend on the cursor. `companyId` is in the same
 * WHERE clause from the authenticated session, so a forged cursor can only
 * move a caller around inside their own company's rows.
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
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type ListReviewsDto = z.infer<typeof listReviewsSchema>;

export interface Keyset {
  readonly createdAt: Date;
  readonly id: string;
}

/** `<iso8601>|<uuid>`, base64url. Opaque to the caller, trivial to debug. */
export function encodeCursor(keyset: Keyset): string {
  return Buffer.from(`${keyset.createdAt.toISOString()}|${keyset.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decodes and VALIDATES.
 *
 * A malformed cursor is a 400, not a 500 and not a silent reset to page one.
 * Silently starting over would make a client paging through a long list loop
 * forever without ever being told why.
 */
export function decodeCursor(value: string): Keyset {
  let decoded: string;

  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw invalidCursor();
  }

  const separator = decoded.indexOf('|');

  if (separator === -1) {
    throw invalidCursor();
  }

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime()) || !UUID.test(id)) {
    throw invalidCursor();
  }

  return { createdAt, id };
}

function invalidCursor(): BadRequestException {
  return new BadRequestException({
    error: 'invalid_cursor',
    message: 'The cursor is not valid. Omit it to start from the first page.',
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
