import { z } from 'zod';
import { MAX_AMOUNT_MINOR } from '../../expenses/dto/submit-expense.dto';

/**
 * The card provider's event, exactly as the assessment specifies it.
 *
 * ```json
 * {
 *   "id": "evt_8f2c1",
 *   "type": "transaction.settled",
 *   "createdAt": "2026-11-20T09:15:02Z",
 *   "data": {
 *     "transactionId": "txn_5531",
 *     "cardholderId": "emp-7",
 *     "amount": 12500,
 *     "currency": "SAR",
 *     "merchant": "City Taxi",
 *     "category": "TRANSPORT",
 *     "spentAt": "2026-11-20T09:15:00Z"
 *   }
 * }
 * ```
 *
 * The field names are the PROVIDER'S, not ours, and they are not renamed on
 * the way in. `cardholderId` becomes our `employeeId` and `transactionId`
 * becomes our `externalId` in exactly one place - the processor - so that the
 * translation is a line of code somebody can read rather than a convention
 * spread across four files.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ENVELOPE AND THE PAYLOAD ARE PARSED SEPARATELY
 * ---------------------------------------------------------------------------
 *
 * An event type this system does not handle still has to be ACCEPTED, because
 * the provider retries until it gets a 2xx and refusing forever is an infinite
 * retry loop. But its `data` has a shape we know nothing about - a
 * `transaction.reversed` or a `card.issued` event would not carry a
 * `transactionId` at all.
 *
 * So the envelope is parsed strictly and `data` is left as `unknown` until the
 * type is known to be one we process. Validating `data` against the settled
 * shape first would reject events we are supposed to accept and ignore.
 */

/** The only event type that becomes an expense. */
export const SUPPORTED_EVENT_TYPE = 'transaction.settled';

/**
 * An ISO-8601 instant with an explicit offset.
 *
 * The same rule `submitExpenseSchema` applies, for the same reason: a bare
 * `2026-11-20T09:15:00` names no instant, and guessing a timezone for money
 * spent somewhere specific is how an expense lands in the wrong frequency
 * window.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/u;

const isoInstant = (field: string) =>
  z
    .string(`${field} must be an ISO-8601 timestamp string`)
    .refine((value) => ISO_INSTANT.test(value), {
      error: `${field} must be an ISO-8601 timestamp with a timezone offset`,
    })
    .refine((value) => Number.isFinite(Date.parse(value)), {
      error: `${field} must be a valid date`,
    });

/**
 * An identifier chosen by the provider.
 *
 * Bounded at 128 to match `externalId` on the expense it becomes - a longer
 * one would be accepted here and then rejected by the submission DTO, turning
 * a clear 400 into an event that is retried five times and gives up.
 *
 * Not trimmed and not case-folded, for the reason `canonical-payload.ts`
 * states: normalising an identifier merges identities, and two different
 * transactions must never be able to collapse into one.
 */
const providerIdentifier = (field: string) =>
  z
    .string(`${field} must be a string`)
    .min(1, `${field} must not be empty`)
    .max(128, `${field} must be 128 characters or fewer`)
    .refine((value) => value === value.trim(), {
      error: `${field} must not have leading or trailing whitespace`,
    })
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
      error: `${field} must not contain control characters`,
    });

/**
 * The envelope.
 *
 * NOT `.strict()`, and that is the one deliberate exception in this codebase.
 *
 * A webhook contract belongs to the provider, and providers add fields. Every
 * major one documents exactly this: new properties may appear and consumers
 * must tolerate them. A strict parse would mean the provider adding
 * `livemode` one Tuesday takes this integration down - and our own `.strict()`
 * rule exists to stop a CALLER smuggling `companyId` or `decision` into a
 * request, which is a different threat. Here the company is decided by the
 * signature, never by the body, so an unexpected property cannot influence
 * anything: it is not read.
 *
 * What IS strict is the inner payload, below. Those fields become money.
 */
export const cardEventEnvelopeSchema = z.object({
  id: providerIdentifier('id'),
  type: z.string('type must be a string').min(1).max(128),
  createdAt: isoInstant('createdAt'),
  data: z.unknown(),
});

export type CardEventEnvelope = z.infer<typeof cardEventEnvelopeSchema>;

/**
 * The settled-transaction payload.
 *
 * `.strict()` here: an unknown field inside `data` is a contract change that
 * affects what an expense says, not a cosmetic addition to the envelope.
 */
export const settledTransactionSchema = z
  .object({
    transactionId: providerIdentifier('transactionId'),
    cardholderId: providerIdentifier('cardholderId'),

    /**
     * Minor units, integer. The provider's example sends `12500` for 125.00
     * SAR, which is the same representation this system uses throughout
     * (ADR-005) - so there is no conversion here and no opportunity for one
     * to be wrong.
     */
    amount: z
      .int('amount must be an integer number of minor units')
      .min(1, 'amount must be greater than zero')
      .max(MAX_AMOUNT_MINOR, `amount must be ${MAX_AMOUNT_MINOR} minor units or fewer`),

    currency: z
      .string('currency must be a string')
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/u, 'currency must be a three-letter ISO-4217 code'),

    merchant: z
      .string('merchant must be a string')
      .min(1, 'merchant must not be empty')
      .max(200, 'merchant must be 200 characters or fewer')
      .refine((value) => value.trim().length > 0, {
        error: 'merchant must not be only whitespace',
      }),

    category: z
      .string('category must be a string')
      .min(1, 'category must not be empty')
      .max(64, 'category must be 64 characters or fewer')
      .refine((value) => value.trim().length > 0, {
        error: 'category must not be only whitespace',
      }),

    /** When the money was spent. See the three-timestamps note in the README. */
    spentAt: isoInstant('spentAt'),
  })
  .strict();

export type SettledTransaction = z.infer<typeof settledTransactionSchema>;
