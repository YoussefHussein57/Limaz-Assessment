import { z } from 'zod';
import { MAX_CURSOR_LENGTH } from '../../common/keyset';
import { MAX_AMOUNT_MINOR } from '../../expenses/dto/submit-expense.dto';

/**
 * Input shapes for the platform administration endpoints.
 *
 * Every schema is `.strict()`. An unknown property is a 400, not a silently
 * ignored field - and here that matters more than usual: an administrator
 * creating a company is setting up a tenant, and a typo in a field name that
 * is quietly dropped produces a company initialised differently from what
 * somebody believes they created.
 */

export const MAX_COMPANY_PAGE_SIZE = 100;
export const DEFAULT_COMPANY_PAGE_SIZE = 25;

export const listCompaniesSchema = z
  .object({
    /** Matches the company name, case-insensitive. */
    q: z
      .string()
      .max(100, 'q must be 100 characters or fewer')
      .trim()
      .transform((value) => (value.length === 0 ? undefined : value))
      .optional(),
    limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(MAX_COMPANY_PAGE_SIZE, `limit must be ${MAX_COMPANY_PAGE_SIZE} or fewer`)
      .default(DEFAULT_COMPANY_PAGE_SIZE),
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  })
  .strict();

export type ListCompaniesDto = z.infer<typeof listCompaniesSchema>;

/**
 * Creating a company.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CREATED, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * Assumption A5, agreed before any of this was built:
 *
 *   "Creating a company creates its policy and first API key, but not a
 *    manager."
 *
 * The policy is not optional. An expense cannot be evaluated without one, so a
 * company without a policy is a tenant that accepts submissions and cannot
 * decide anything - which is why it is created in the SAME transaction.
 *
 * The first API key comes with it because that is the credential the company's
 * backend needs, and issuing it at creation means the administrator hands over
 * one artefact rather than coming back for a second.
 *
 * NO MANAGER is created, and that is deliberate rather than unfinished.
 * Creating one would mean either inventing a password - predictable, or
 * exposed, or both - or building an invitation flow with email delivery, which
 * is a subsystem the assessment does not ask for. The limitation is documented
 * (R-32) and the company detail page says plainly that the company has no
 * manager yet.
 */
export const createCompanySchema = z
  .object({
    name: z
      .string('name must be a string')
      .trim()
      .min(1, 'name must not be empty')
      .max(200, 'name must be 200 characters or fewer'),

    /**
     * ISO-4217, and uppercased here so `sar` and `SAR` create the same
     * company rather than two that differ invisibly (assumption A3: one
     * currency per company).
     */
    currency: z
      .string('currency must be a string')
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/u, 'currency must be a three-letter ISO-4217 code'),

    /**
     * The starting policy. Optional, with defaults, because an administrator
     * setting up a tenant should not have to invent a frequency window - but
     * supplying one is allowed, so a company with known rules can be created
     * correctly in one step.
     */
    autoApproveLimitMinor: z
      .int('autoApproveLimitMinor must be an integer number of minor units')
      .min(0, 'autoApproveLimitMinor must not be negative')
      .max(MAX_AMOUNT_MINOR, `autoApproveLimitMinor must be ${MAX_AMOUNT_MINOR} or fewer`)
      .default(50_000),

    frequencyMaxCount: z
      .int('frequencyMaxCount must be an integer')
      .min(1, 'frequencyMaxCount must be at least 1')
      .max(1_000, 'frequencyMaxCount must be 1000 or fewer')
      .default(3),

    frequencyWindowMinutes: z
      .int('frequencyWindowMinutes must be an integer')
      .min(1, 'frequencyWindowMinutes must be at least 1 minute')
      .max(1_440, 'frequencyWindowMinutes must be 1440 or fewer')
      .default(60),

    blockedCategories: z
      .array(z.string().min(1).max(64))
      .max(100, 'blockedCategories must contain 100 entries or fewer')
      .default([]),
  })
  .strict();

export type CreateCompanyDto = z.infer<typeof createCompanySchema>;
