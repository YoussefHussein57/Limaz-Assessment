import { z } from 'zod';
import { MAX_AMOUNT_MINOR } from '../../expenses/dto/submit-expense.dto';

/**
 * What a manager may change about their company's policy.
 *
 * ---------------------------------------------------------------------------
 * WHY ALL FOUR FIELDS ARE EDITABLE
 * ---------------------------------------------------------------------------
 *
 * Not because a column exists - a column existing is never the reason. The
 * project's own requirements matrix records two entries that settle it:
 *
 *   "Per-company policy settings in the database"
 *   "The two companies seeded with different values"
 *
 * and the seed implements them: Nile runs 3 expenses per 60 minutes, Delta
 * runs 5 per 30. A frequency rule that were a fixed platform constant could
 * not be seeded differently per company, and F04's tests assert both
 * configurations behave differently. So the established contract is that all
 * four are company policy, and this endpoint does not widen it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A PATCH AND EVERY FIELD IS OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * A PUT would mean "replace the whole policy", so a client that sent only the
 * limit would silently clear the blocked-category list. Every field is
 * optional here and an absent field is left alone - but an EMPTY REQUEST is
 * refused, because sending nothing is almost always a bug and answering 200
 * to it hides that.
 *
 * `.strict()`, so `companyId` in the body is a 400 rather than a silently
 * ignored field. The tenant comes from the session and from nowhere else.
 */

/** A frequency window longer than a day stops being a burst rule. */
export const MAX_FREQUENCY_WINDOW_MINUTES = 1_440;

/** Above this the rule can never fire in any realistic window. */
export const MAX_FREQUENCY_COUNT = 1_000;

/** The list is read whole on every evaluation, so it is kept short. */
export const MAX_BLOCKED_CATEGORIES = 100;

export const MAX_CATEGORY_LENGTH = 64;

export const updatePolicySchema = z
  .object({
    /**
     * Minor units, integer. The same representation the expense uses
     * (ADR-005), so the comparison in `amountLimitRule` is integer against
     * integer with no conversion anywhere.
     *
     * Zero is ALLOWED and means "every expense needs review" - a coherent,
     * if strict, policy. Negative is not: the rule compares against an
     * expense amount that a CHECK constraint already keeps non-negative.
     */
    autoApproveLimitMinor: z
      .int('autoApproveLimitMinor must be an integer number of minor units')
      .min(0, 'autoApproveLimitMinor must not be negative')
      .max(
        MAX_AMOUNT_MINOR,
        `autoApproveLimitMinor must be ${MAX_AMOUNT_MINOR} minor units or fewer`,
      )
      .optional(),

    /**
     * How many expenses in the window before the rule fires.
     *
     * At least 1. Zero would mean the rule fires on an employee's first
     * expense ever, which is not a frequency rule - and assumption A1 says
     * the rule fires when the count INCLUDING the current expense exceeds
     * this, so 0 would flag everything while looking like a configuration.
     */
    frequencyMaxCount: z
      .int('frequencyMaxCount must be an integer')
      .min(1, 'frequencyMaxCount must be at least 1')
      .max(MAX_FREQUENCY_COUNT, `frequencyMaxCount must be ${MAX_FREQUENCY_COUNT} or fewer`)
      .optional(),

    frequencyWindowMinutes: z
      .int('frequencyWindowMinutes must be an integer')
      .min(1, 'frequencyWindowMinutes must be at least 1 minute')
      .max(
        MAX_FREQUENCY_WINDOW_MINUTES,
        `frequencyWindowMinutes must be ${MAX_FREQUENCY_WINDOW_MINUTES} or fewer`,
      )
      .optional(),

    /**
     * The blocked list, as the caller typed it.
     *
     * NOT normalised here. `PolicyService` runs the same
     * `normaliseCategory()` the expense pipeline uses, because two
     * normalisation implementations is two chances for one side to say
     * "GAMBLING" while the other says "gambling" and the rule to stop firing
     * without anything looking wrong (F07-B07).
     *
     * An empty array is valid and means "nothing is blocked".
     */
    blockedCategories: z
      .array(
        z
          .string('each blocked category must be a string')
          .min(1, 'a blocked category must not be empty')
          .max(
            MAX_CATEGORY_LENGTH,
            `a blocked category must be ${MAX_CATEGORY_LENGTH} characters or fewer`,
          ),
      )
      .max(
        MAX_BLOCKED_CATEGORIES,
        `blockedCategories must contain ${MAX_BLOCKED_CATEGORIES} entries or fewer`,
      )
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    error: 'Provide at least one field to update.',
  });

export type UpdatePolicyDto = z.infer<typeof updatePolicySchema>;
