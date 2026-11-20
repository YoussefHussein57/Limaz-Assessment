import { createHash } from 'node:crypto';

/**
 * The canonical form of an expense's business payload, and its SHA-256 hash.
 *
 * This is what makes "is this the same expense?" a decidable question rather
 * than a judgement call (ADR-001). Two semantically identical submissions must
 * produce the same hash; any business-significant difference must produce a
 * different one.
 *
 * ---------------------------------------------------------------------------
 * THE GOVERNING RULE: IDENTIFIERS ARE COMPARED EXACTLY, CONTENT IS NORMALISED
 * ---------------------------------------------------------------------------
 *
 * Normalising an identifier MERGES IDENTITIES. If ` exp-1` were trimmed to
 * `exp-1`, a caller submitting the first would receive the decision belonging
 * to the second - silently, and with no way to notice. The same applies to
 * case folding and to Unicode normalisation.
 *
 * So `externalId` and `employeeId` are treated as opaque byte sequences. They
 * are never trimmed, case-folded or NFC-normalised here; a value carrying
 * surrounding whitespace is REJECTED by the DTO (400) rather than quietly
 * repaired, because a loud error the caller can fix is better than a silent
 * merge they cannot see.
 *
 * `merchant`, `category` and `currency` are content, not identity. Normalising
 * them removes spurious 409s that carry no business meaning.
 *
 * ---------------------------------------------------------------------------
 * COMPATIBILITY CONTRACT - VERSION 1, FROZEN 2026-11-20
 * ---------------------------------------------------------------------------
 *
 * This is a contract, not an implementation detail. Every expense already in
 * the database carries a hash computed under these exact rules, and those
 * hashes are compared against freshly computed ones forever.
 *
 * A change here does NOT take effect going forward. It RETROACTIVELY
 * INVALIDATES EVERY STORED HASH: a correct retry of an existing expense would
 * hash differently, be read as a conflicting resubmission, and be refused
 * with a 409 the caller cannot resolve.
 *
 * BREAKING: adding a field, removing a field, reordering, changing any
 * normalisation rule, changing the algorithm or the encoding.
 * NOT BREAKING: adding a column to `expenses` that is not hashed; changing
 * the response shape.
 *
 * If it ever must change, do NOT edit this function. Add a
 * `payloadHashVersion` column, write new expenses under version 2, and
 * compare an existing expense using the version it was stored with. That
 * upgrade path is deliberately not built; it is documented in
 * docs/features/F03-expense-submission.md and carried as risk R-26.
 *
 * `canonical-payload.spec.ts` pins the exact output string, so the contract
 * cannot drift without someone editing an assertion on purpose.
 */

/** The six business fields. Nothing server-generated appears here. */
export interface CanonicalExpenseInput {
  readonly employeeId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchant: string;
  readonly category: string;
  readonly spentAt: Date;
}

/** The normalised values, used for BOTH the hash and the database row. */
export interface NormalisedExpense {
  readonly employeeId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchant: string;
  readonly category: string;
  readonly spentAt: Date;
}

/**
 * Normalises the content fields and leaves the identifiers untouched.
 *
 * The result is what gets persisted AND what gets hashed. Hashing one value
 * and storing another is how a genuine retry ends up conflicting with the row
 * it is a retry of: the stored timestamp would be truncated to milliseconds by
 * the column type while the hash covered the microseconds that were dropped.
 */
export function normaliseExpense(input: CanonicalExpenseInput): NormalisedExpense {
  return {
    // Identifier: untouched. See the rule above.
    employeeId: input.employeeId,

    amountMinor: input.amountMinor,

    // ISO-4217 codes are case-insensitive by convention, so `sar` and `SAR`
    // are the same currency and must not conflict.
    currency: input.currency.trim().toUpperCase(),

    // Content. NFC because two visually identical merchant names can carry
    // different Unicode encodings - common with Arabic and with accented
    // Latin text - and without this they would hash differently. Internal
    // whitespace runs collapse because "City  Taxi" and "City Taxi" are the
    // same merchant; case is PRESERVED, because changing a merchant's name is
    // a real change the caller made.
    merchant: collapseWhitespace(input.merchant.normalize('NFC').trim()),

    // Uppercased because the schema stores it uppercase, so that blocked-list
    // matching in F04 is an exact comparison rather than a case-insensitive
    // search (see the comment on Expense.category).
    category: collapseWhitespace(input.category.normalize('NFC').trim()).toUpperCase(),

    // A JS Date is already millisecond-precision, which is exactly the
    // precision of the Timestamptz(3) column. Constructing a new Date makes
    // that explicit and removes any doubt about what was stored.
    spentAt: new Date(input.spentAt.getTime()),
  };
}

/**
 * The canonical serialisation: a fixed-order JSON ARRAY, not an object.
 *
 * An array makes the question of key ordering impossible to ask - order is
 * part of the structure, not a property of the serialiser. An object would
 * require sorting keys and trusting every future engine to agree.
 *
 * It is also why there is no hand-rolled separator. Joining with a delimiter
 * would collide: merchant `a|b` with category `C` and merchant `a` with
 * category `b|C` produce the same string. JSON escapes quotes inside each
 * value, so no value can impersonate a field boundary.
 *
 * A general-purpose canonicalisation library (RFC 8785 JCS) solves arbitrary
 * JSON: nested key ordering, number formatting edge cases, Unicode collation.
 * With six fields of known types that is a dependency paying for a problem we
 * do not have, and one more thing to defend in review.
 */
export function canonicalString(normalised: NormalisedExpense): string {
  return JSON.stringify([
    normalised.employeeId,
    normalised.amountMinor,
    normalised.currency,
    normalised.merchant,
    normalised.category,
    // Always UTC, always `YYYY-MM-DDTHH:mm:ss.sssZ`, so `+03:00` and `Z`
    // representations of the same instant serialise identically.
    normalised.spentAt.toISOString(),
  ]);
}

/** SHA-256 of the canonical string, hex encoded. */
export function payloadHashOf(normalised: NormalisedExpense): string {
  return createHash('sha256').update(canonicalString(normalised), 'utf8').digest('hex');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ');
}
