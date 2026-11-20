import {
  canonicalString,
  normaliseExpense,
  payloadHashOf,
  type CanonicalExpenseInput,
} from '../../src/expenses/canonical-payload';

/**
 * F03-T15, F03-T16 and the canonicalisation contract.
 *
 * These are unit tests with no database, because the question is purely about
 * the function: does it collapse the differences that carry no business
 * meaning, and preserve every difference that does?
 *
 * Both directions matter equally. A hash that is too forgiving silently
 * accepts a changed amount as a retry; a hash that is too strict rejects a
 * legitimate retry with a 409 the caller cannot resolve.
 */

const BASE: CanonicalExpenseInput = {
  employeeId: 'emp-7',
  amountMinor: 12_500,
  currency: 'SAR',
  merchant: 'City Taxi',
  category: 'TRANSPORT',
  spentAt: new Date('2026-11-20T09:15:00.000Z'),
};

const hashOf = (input: CanonicalExpenseInput): string => payloadHashOf(normaliseExpense(input));

describe('F03 canonical payload', () => {
  it('F03-T15: JSON property order cannot change the hash', () => {
    // Two bodies that differ only in key order. The canonical form is an
    // ARRAY, so by the time anything is hashed the ordering question has
    // already been answered by the structure - this asserts the property the
    // design relies on, rather than a behaviour of JSON.stringify.
    const a = hashOf({
      employeeId: 'emp-7',
      amountMinor: 12_500,
      currency: 'SAR',
      merchant: 'City Taxi',
      category: 'TRANSPORT',
      spentAt: new Date('2026-11-20T09:15:00.000Z'),
    });

    const b = hashOf({
      spentAt: new Date('2026-11-20T09:15:00.000Z'),
      category: 'TRANSPORT',
      merchant: 'City Taxi',
      currency: 'SAR',
      amountMinor: 12_500,
      employeeId: 'emp-7',
    });

    expect(a).toBe(b);
  });

  it('F03-T16: the same instant in a different timezone hashes identically', () => {
    // 12:15 at +03:00 IS 09:15Z. Same instant, same expense.
    expect(hashOf({ ...BASE, spentAt: new Date('2026-11-20T12:15:00.000+03:00') })).toBe(
      hashOf(BASE),
    );
  });

  it('F03-T16b: a different instant written with an offset still differs', () => {
    // The mirror image: the offset must not be ignored, only resolved.
    expect(hashOf({ ...BASE, spentAt: new Date('2026-11-20T09:15:00.000+03:00') })).not.toBe(
      hashOf(BASE),
    );
  });

  it('sub-millisecond precision cannot survive, so it cannot change the hash', () => {
    // The column is Timestamptz(3). If the hash covered microseconds that the
    // column drops, a retry of the stored row would conflict with itself.
    expect(hashOf({ ...BASE, spentAt: new Date('2026-11-20T09:15:00.000999Z') })).toBe(
      hashOf(BASE),
    );
  });

  it('currency case is irrelevant; ISO-4217 codes are case-insensitive', () => {
    expect(hashOf({ ...BASE, currency: 'sar' })).toBe(hashOf(BASE));
  });

  it('category case and surrounding whitespace are irrelevant', () => {
    expect(hashOf({ ...BASE, category: '  transport ' })).toBe(hashOf(BASE));
  });

  it('merchant whitespace runs collapse, but case is preserved', () => {
    expect(hashOf({ ...BASE, merchant: 'City   Taxi' })).toBe(hashOf(BASE));
    // Renaming the merchant is a real change the caller made, not formatting.
    expect(hashOf({ ...BASE, merchant: 'CITY TAXI' })).not.toBe(hashOf(BASE));
  });

  it('Unicode-equivalent merchant names hash identically', () => {
    // `é` as one code point vs `e` + combining acute. Visually identical,
    // different bytes. Without NFC these would be a spurious 409.
    const composed = hashOf({ ...BASE, merchant: 'Café Rio' });
    const decomposed = hashOf({ ...BASE, merchant: 'Café Rio' });

    expect(composed).toBe(decomposed);
  });

  describe('identifiers are compared exactly, because normalising them merges identities', () => {
    it('employeeId case is significant', () => {
      // `emp-7` and `EMP-7` may be two different people in the caller's
      // system. Folding them would attribute one person's spending to another
      // and put both in the same frequency window.
      expect(hashOf({ ...BASE, employeeId: 'EMP-7' })).not.toBe(hashOf(BASE));
    });

    it('employeeId whitespace is significant', () => {
      expect(hashOf({ ...BASE, employeeId: 'emp-7 ' })).not.toBe(hashOf(BASE));
    });

    it('employeeId Unicode form is significant', () => {
      expect(hashOf({ ...BASE, employeeId: 'emṕ-7' })).not.toBe(
        hashOf({ ...BASE, employeeId: 'empé-7' }),
      );
    });
  });

  describe('every covered field changes the hash', () => {
    const variants: [string, CanonicalExpenseInput][] = [
      ['employeeId', { ...BASE, employeeId: 'emp-8' }],
      ['amountMinor', { ...BASE, amountMinor: 12_501 }],
      ['currency', { ...BASE, currency: 'USD' }],
      ['merchant', { ...BASE, merchant: 'Desert Taxi' }],
      ['category', { ...BASE, category: 'MEALS' }],
      ['spentAt', { ...BASE, spentAt: new Date('2026-11-20T09:15:01.000Z') }],
    ];

    it.each(variants)('changing %s produces a different hash', (_field, variant) => {
      expect(hashOf(variant)).not.toBe(hashOf(BASE));
    });

    it('a one-minor-unit difference is detected', () => {
      // The case that matters most: 125.00 vs 125.01 must never be a retry.
      expect(hashOf({ ...BASE, amountMinor: 12_499 })).not.toBe(hashOf(BASE));
    });
  });

  it('no value can impersonate a field boundary', () => {
    // The classic delimiter bug. Joining fields with a separator would make
    // these two collide; JSON escaping is what prevents it.
    const a = hashOf({ ...BASE, merchant: 'a"|"b', category: 'C' });
    const b = hashOf({ ...BASE, merchant: 'a', category: 'b"|"C' });

    expect(a).not.toBe(b);
  });

  it('the canonical string is a fixed-order array, and is stable', () => {
    // Pinned deliberately: this string IS the contract. A change here changes
    // which resubmissions count as conflicts for every expense already stored,
    // so it should require editing this assertion on purpose (risk R-26).
    expect(canonicalString(normaliseExpense(BASE))).toBe(
      '["emp-7",12500,"SAR","City Taxi","TRANSPORT","2026-11-20T09:15:00.000Z"]',
    );
  });

  it('the hash is SHA-256 hex', () => {
    expect(payloadHashOf(normaliseExpense(BASE))).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('normalisation output is what gets stored, not just what gets hashed', () => {
    const normalised = normaliseExpense({
      ...BASE,
      currency: 'sar',
      category: ' transport ',
      merchant: ' City   Taxi ',
    });

    // Asserting the VALUES, because these are the ones written to the row. If
    // the service stored the raw input instead, a retry of the stored row
    // would hash differently from the row itself.
    expect(normalised.currency).toBe('SAR');
    expect(normalised.category).toBe('TRANSPORT');
    expect(normalised.merchant).toBe('City Taxi');
    expect(normalised.employeeId).toBe('emp-7');
  });
});
