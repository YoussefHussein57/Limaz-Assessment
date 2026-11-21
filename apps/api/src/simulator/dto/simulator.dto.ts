import { z } from 'zod';
import { MAX_CURSOR_LENGTH } from '../../common/keyset';
import { MAX_AMOUNT_MINOR } from '../../expenses/dto/submit-expense.dto';

/**
 * Input for the sandbox simulator and the webhook event history (F12).
 *
 * Every schema is `.strict()`. There is deliberately NO destination field and
 * no signing-secret field: the destination is a constant on the loopback
 * interface, and the secret is read from the database inside the process. A
 * caller who could supply either would have an authenticated SSRF primitive
 * or a way to make the server sign something with a key of their choosing.
 */

export const simulatePaymentSchema = z
  .object({
    companyId: z.uuid('companyId must be a UUID'),

    /**
     * How the request should be signed.
     *
     * The failure modes send a genuinely wrong signature or a genuinely stale
     * timestamp to the real verifier. None of them disables a check.
     */
    mode: z.enum(['VALID', 'INVALID_SIGNATURE', 'EXPIRED_SIGNATURE']).default('VALID'),

    /**
     * The provider event type. Settable so an unsupported type can be
     * demonstrated - it is accepted and ignored rather than refused, and
     * seeing that happen is worth a preset.
     */
    eventType: z.string().min(1).max(128).default('transaction.settled'),

    /**
     * Redeliver a stored event VERBATIM.
     *
     * ---------------------------------------------------------------------
     * WHY THIS IS NOT JUST "PASS THE SAME eventId"
     * ---------------------------------------------------------------------
     *
     * That was the first design, and it does not work. The payload identity
     * covers every business field including `spentAt`, which defaults to
     * "now" when the caller omits it - so re-sending with the same event id
     * produced a genuinely DIFFERENT payload a second later, and the endpoint
     * correctly answered 409 `event_payload_conflict`. The preset could never
     * demonstrate the behaviour it was named after (AI_LOG 56).
     *
     * A real provider replaying an event re-sends the bytes it sent before.
     * So does this: the stored payload is read back and re-signed, which is
     * the only thing that deserves to be called a redelivery.
     */
    replayOf: z.string().min(1).max(128).optional(),

    /**
     * Use this provider event id instead of generating one.
     *
     * Combined with a changed business field this produces the CONFLICTING
     * case - the same event identity describing a different payment - which
     * is a separate behaviour from a replay and is refused rather than
     * acknowledged.
     */
    eventId: z.string().min(1).max(128).optional(),
    transactionId: z.string().min(1).max(128).optional(),

    cardholderId: z
      .string('cardholderId must be a string')
      .min(1, 'cardholderId must not be empty')
      .max(128, 'cardholderId must be 128 characters or fewer')
      .refine((value) => value === value.trim(), {
        error: 'cardholderId must not have leading or trailing whitespace',
      }),

    /** Minor units, so no floating point conversion happens anywhere. */
    amount: z
      .int('amount must be an integer number of minor units')
      .min(1, 'amount must be greater than zero')
      .max(MAX_AMOUNT_MINOR, `amount must be ${MAX_AMOUNT_MINOR} minor units or fewer`),

    merchant: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(64),

    /** Omitted means "now". See the three-timestamps note in the README. */
    spentAt: z.string().min(1).max(64).optional(),
  })
  .strict();

export type SimulatePaymentDto = z.infer<typeof simulatePaymentSchema>;

export const MAX_EVENT_PAGE_SIZE = 100;
export const DEFAULT_EVENT_PAGE_SIZE = 25;

export const listWebhookEventsSchema = z
  .object({
    companyId: z.uuid('companyId must be a UUID').optional(),
    status: z.enum(['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED']).optional(),
    limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(MAX_EVENT_PAGE_SIZE, `limit must be ${MAX_EVENT_PAGE_SIZE} or fewer`)
      .default(DEFAULT_EVENT_PAGE_SIZE),
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  })
  .strict();

export type ListWebhookEventsDto = z.infer<typeof listWebhookEventsSchema>;
