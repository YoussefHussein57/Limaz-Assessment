import { z } from 'zod';

/**
 * Expense submission input - SHAPE validation only.
 *
 * Everything here is time-independent and tenant-independent, so the same body
 * is either well-formed or it is not, today and in ninety days. That property
 * is load-bearing: a retry of an expense accepted three months ago must still
 * parse, so that the idempotency lookup can run and return the original
 * decision. Business rules that DO depend on time or tenant - the spentAt
 * window (A4) and the company currency (A3) - deliberately live later, after
 * the idempotency check, and answer 422 rather than 400 (test F03-T25).
 *
 * `.strict()` is the security-relevant part. A body carrying `companyId`,
 * `decision`, `status` or `payloadHash` is refused outright rather than parsed
 * and partly ignored, so there is no shape of request in which a
 * caller-supplied tenant or decision could reach the service at all
 * (test F03-T12).
 */

/** PostgreSQL `int4`, which is what `Expense.amountMinor` is. */
export const MAX_AMOUNT_MINOR = 2_147_483_647;

/**
 * An opaque identifier supplied by the caller's own system.
 *
 * NOT trimmed, NOT case-folded, NOT NFC-normalised. Every one of those merges
 * two distinct caller identities into one, and the caller would receive
 * another record's decision with nothing to indicate it. A value with
 * surrounding whitespace is rejected instead, so the mistake is visible and
 * fixable rather than silent.
 *
 * Control characters are refused for the same reason they are refused in a
 * log line: they make two different identifiers render identically.
 */
function opaqueIdentifier(field: string, max: number) {
  return z
    .string({ error: `${field} must be a string` })
    .min(1, `${field} must not be empty`)
    .max(max, `${field} must be ${max} characters or fewer`)
    .refine((value) => value === value.trim(), {
      error: `${field} must not have leading or trailing whitespace`,
    })
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
      error: `${field} must not contain control characters`,
    });
}

export const submitExpenseSchema = z
  .object({
    externalId: opaqueIdentifier('externalId', 128),
    employeeId: opaqueIdentifier('employeeId', 128),

    /**
     * Minor units as an integer (ADR-005). `z.int()` rejects 12.5 outright
     * rather than rounding it - a rounded amount is a wrong amount, and money
     * that silently changes value is the exact failure ADR-005 exists to
     * prevent. The upper bound is the column's, not an opinion: int4 overflows
     * at 2,147,483,647 minor units, and a value above it would be a database
     * error rather than a validation one.
     */
    amount: z
      .int({ error: 'amount must be an integer number of minor units' })
      .min(1, 'amount must be greater than zero')
      .max(MAX_AMOUNT_MINOR, `amount must be ${MAX_AMOUNT_MINOR} minor units or fewer`),

    /** Format only. Whether it is THIS company's currency is A3, checked later. */
    currency: z
      .string({ error: 'currency must be a string' })
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/u, 'currency must be a three-letter ISO-4217 code'),

    merchant: z
      .string({ error: 'merchant must be a string' })
      .min(1, 'merchant must not be empty')
      .max(200, 'merchant must be 200 characters or fewer')
      .refine((value) => value.trim().length > 0, {
        error: 'merchant must not be only whitespace',
      }),

    /**
     * A free string, normalised to uppercase (risk R-17). Not an enum: the
     * category vocabulary belongs to the company, and an enum would make every
     * new category a migration.
     */
    category: z
      .string({ error: 'category must be a string' })
      .min(1, 'category must not be empty')
      .max(64, 'category must be 64 characters or fewer')
      .refine((value) => value.trim().length > 0, {
        error: 'category must not be only whitespace',
      }),

    /**
     * An ISO-8601 instant. An offset is required - a bare `2026-11-20T09:15:00`
     * has no defined instant, and guessing a timezone for money that was spent
     * somewhere specific is how an expense lands in the wrong frequency window.
     */
    spentAt: z
      .string({ error: 'spentAt must be an ISO-8601 timestamp string' })
      .refine((value) => ISO_INSTANT.test(value), {
        error: 'spentAt must be an ISO-8601 timestamp with a timezone offset',
      })
      .refine((value) => Number.isFinite(Date.parse(value)), {
        error: 'spentAt must be a valid date',
      })
      .refine(isRealCalendarDate, {
        error: 'spentAt must be a date that exists in the calendar',
      }),
  })
  .strict();

export type SubmitExpenseDto = z.infer<typeof submitExpenseSchema>;

/**
 * Requires a date, a time, and an explicit offset or `Z`.
 *
 * Deliberately stricter than `Date.parse`, which accepts `2026-13-45` in some
 * engines and silently reinterprets it.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/u;

/**
 * Rejects a date that does not exist, instead of letting it roll over.
 *
 * `Date.parse('2026-02-30T09:15:00Z')` does not fail. February 2026 has 28
 * days, so it rolls the surplus over and returns **2 March** - two days past
 * the end of the month. The regex above is satisfied and `Number.isFinite` is
 * satisfied, so without this the expense would be stored on a date the caller
 * never wrote, in a different frequency window, with nothing anywhere
 * recording that a substitution happened.
 *
 * There is no meaningful "difference" to quote, because 30 February does not
 * exist: the stored date is simply not the submitted one.
 *
 * Checked against the calendar fields from the string itself rather than
 * against the parsed UTC date, because an offset legitimately moves the UTC
 * day: `2026-11-20T01:00:00+03:00` really is 19 November in UTC.
 */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);

  if (!match) {
    return false;
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));

  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}
