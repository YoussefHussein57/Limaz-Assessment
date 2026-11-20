import { z } from 'zod';

/**
 * Login input.
 *
 * `.strict()` is the security-relevant part, not the field validation: it
 * rejects any property we did not declare. A body carrying `companyId`,
 * `role`, or `userId` is refused outright rather than parsed and partly
 * ignored, so there is no shape of request in which a caller-supplied tenant
 * or role could reach the service layer at all (test F02-T15).
 *
 * The password bound is deliberately generous at the low end - this endpoint
 * verifies existing credentials, it does not set policy for new ones, and a
 * "password too short" response on login would confirm that the email exists.
 */
export const loginSchema = z
  .object({
    email: z.string().min(1).max(320).trim().toLowerCase(),
    password: z.string().min(1).max(512),
  })
  .strict();

export type LoginDto = z.infer<typeof loginSchema>;
