import { z } from 'zod';
import { MAX_CURSOR_LENGTH } from '../../common/keyset';

/**
 * Query input for the manager's expense listing.
 *
 * `.strict()`, so an unknown parameter is a 400 rather than a silently ignored
 * one. That matters more than it looks: a client that sends `companyId=...`
 * and gets 200 back has every reason to believe it was honoured. It was not,
 * and it never will be - the tenant comes from the session (F06-T05). Saying
 * so loudly is the only honest answer.
 *
 * ---------------------------------------------------------------------------
 * WHY `decision` AND `status` ARE BOTH FILTERS
 * ---------------------------------------------------------------------------
 *
 * They answer different questions and neither can be derived from the other:
 *
 *   decision = REVIEW, status = PENDING_REVIEW  - flagged, nobody looked yet
 *   decision = REVIEW, status = APPROVED        - flagged, a manager approved
 *   decision = APPROVE, status = APPROVED       - never flagged at all
 *
 * "Show me everything the policy flagged" and "show me what is still waiting"
 * are different lists, and a dashboard that offers only one of them cannot
 * express the distinction the rest of this system is built around.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 * A date range. It is listed as optional in the F06 brief and it is left out
 * on purpose: it would widen the cursor contract (a range bound interacts with
 * the `spentAt` ordering) to answer a question no requirement asks. Recorded
 * as an omission in docs/features/F06-manager-dashboard.md rather than quietly
 * skipped.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** Bounds the search term. Long enough to be useful, short enough to be safe. */
export const MAX_SEARCH_LENGTH = 100;

export const listExpensesSchema = z
  .object({
    /** The CURRENT outcome. */
    status: z.enum(['APPROVED', 'REJECTED', 'PENDING_REVIEW', 'ALL']).default('ALL'),

    /** What the policy concluded at submission. Never changes. */
    decision: z.enum(['APPROVE', 'REVIEW', 'REJECT', 'ALL']).default('ALL'),

    /**
     * Free-text search over merchant, external reference and employee
     * reference.
     *
     * Trimmed, and an all-whitespace term is treated as no term at all rather
     * than as a search for nothing. This is CONTENT matching, which is a
     * different activity from the identifier comparison F03 governs: that rule
     * exists so two distinct client identities cannot be merged on WRITE.
     * Nothing here writes, and a prefix match cannot merge anything.
     */
    q: z
      .string()
      .max(MAX_SEARCH_LENGTH, `q must be ${MAX_SEARCH_LENGTH} characters or fewer`)
      .trim()
      .transform((value) => (value.length === 0 ? undefined : value))
      .optional(),

    /**
     * Categories are stored normalised to uppercase (F03), so the filter is
     * normalised the same way. Without this, `category=food` would match
     * nothing and look like an empty company rather than a mismatched filter.
     */
    category: z
      .string()
      .max(64)
      .trim()
      .transform((value) => (value.length === 0 ? undefined : value.toUpperCase()))
      .optional(),

    limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(MAX_PAGE_SIZE, `limit must be ${MAX_PAGE_SIZE} or fewer`)
      .default(DEFAULT_PAGE_SIZE),

    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  })
  .strict();

export type ListExpensesDto = z.infer<typeof listExpensesSchema>;
