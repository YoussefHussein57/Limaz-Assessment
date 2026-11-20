import { BadRequestException } from '@nestjs/common';

/**
 * Keyset cursors, shared by every paginated listing.
 *
 * ---------------------------------------------------------------------------
 * WHY KEYSET AND NOT OFFSET - AND WHY THE ANSWER IS DIFFERENT PER LISTING
 * ---------------------------------------------------------------------------
 *
 * Offset pagination asks "skip N rows". That is only meaningful if the rows
 * before N do not change while the reader is paging, and in this system they
 * change in BOTH directions:
 *
 *   Reviews (F05)  - the default set is OPEN reviews, and it SHRINKS as
 *                    managers resolve them. Rows after the resolved one shift
 *                    UP, so page 2 starts past rows page 1 never showed. The
 *                    reader silently LOSES work.
 *
 *   Expenses (F06) - the set GROWS at the head, because a company's backend
 *                    keeps submitting and the order is newest-first. Rows
 *                    shift DOWN, so page 2 repeats the tail of page 1. The
 *                    reader sees DUPLICATES.
 *
 * Opposite movements, same broken tool. A keyset cursor says "everything
 * strictly after this value", which is unaffected by either.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CURSOR IS A PAIR
 * ---------------------------------------------------------------------------
 *
 * 1. The timestamp columns are `Timestamptz(3)` - ONE MILLISECOND of
 *    resolution. Any bulk insert, import or backfill can produce ties, and a
 *    cursor on the timestamp alone would skip or repeat the tied rows forever.
 *
 * 2. `id` is a UUIDv7, which is APPROXIMATELY time-ordered - and approximately
 *    is not a contract. Its embedded timestamp and the column's value come
 *    from different sources and need not agree, so ordering by `id` alone
 *    would not match the ordering the API promises.
 *
 * So every listing orders by `(<timestamp> DESC, id DESC)` and the cursor
 * carries both, which makes the ordering total however the ties arise.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SURVIVES THE CURSOR ROW DISAPPEARING
 * ---------------------------------------------------------------------------
 *
 * The cursor is compared as a VALUE, never looked up as a row. Prisma's own
 * `cursor` option does a row lookup and would fail - or silently return
 * nothing - once that row leaves the filtered set. For reviews that is the
 * normal case rather than an edge case; for expenses a filter change can do
 * the same thing.
 *
 * Tenant isolation does not depend on the cursor. `companyId` is in the same
 * WHERE clause, from the authenticated session, so a forged cursor can only
 * move a caller around inside their own company's rows.
 */

/** The maximum length accepted for a cursor string, before decoding. */
export const MAX_CURSOR_LENGTH = 200;

export interface Keyset {
  readonly timestamp: Date;
  readonly id: string;
}

/** `<iso8601>|<uuid>`, base64url. Opaque to the caller, trivial to debug. */
export function encodeCursor(keyset: Keyset): string {
  return Buffer.from(`${keyset.timestamp.toISOString()}|${keyset.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decodes and VALIDATES.
 *
 * A malformed cursor is a 400 - not a 500, and not a silent reset to page one.
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

  const timestamp = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(timestamp.getTime()) || !UUID.test(id)) {
    throw invalidCursor();
  }

  return { timestamp, id };
}

function invalidCursor(): BadRequestException {
  return new BadRequestException({
    error: 'invalid_cursor',
    message: 'The cursor is not valid. Omit it to start from the first page.',
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
