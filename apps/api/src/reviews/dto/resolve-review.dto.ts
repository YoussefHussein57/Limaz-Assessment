import { z } from 'zod';

/**
 * Review resolution input.
 *
 * One field. `.strict()` is the security-relevant part, not the enum: a body
 * carrying `reviewerId`, `companyId`, `resolvedAt`, `state` or `status` is
 * REFUSED outright rather than parsed and partly ignored.
 *
 * Refusing rather than ignoring matters here more than usual. An ignored
 * `reviewerId` leaves the caller believing they recorded who acted, and the
 * audit trail then says something nobody intended. Every one of those fields
 * is server-owned: the reviewer comes from the authenticated session, the
 * tenant from the same place, and the timestamp from the database.
 *
 * `decision` rather than `outcome` in the request, because that is the word a
 * manager uses. It maps to `ReviewOutcome` on the way in - the schema's
 * vocabulary stays the schema's.
 */
export const resolveReviewSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT'], {
      error: "decision must be either 'APPROVE' or 'REJECT'",
    }),
  })
  .strict();

export type ResolveReviewDto = z.infer<typeof resolveReviewSchema>;

/** The manager's word, in the schema's vocabulary. */
export function outcomeFor(decision: ResolveReviewDto['decision']) {
  return decision === 'APPROVE' ? ('APPROVED' as const) : ('REJECTED' as const);
}

/** The expense status implied by a resolution (ADR-004). */
export function expenseStatusFor(decision: ResolveReviewDto['decision']) {
  return decision === 'APPROVE' ? ('APPROVED' as const) : ('REJECTED' as const);
}
