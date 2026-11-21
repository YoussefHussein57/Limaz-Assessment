import {
  currencyExponent,
  formatDate,
  formatDateTime,
  formatMoney,
  parseMajorUnits,
  pluralise,
  toMajorUnitString,
} from './format';

/**
 * F06-T29 and F06-T30 - money and date formatting.
 *
 * These two functions carry the pieces of this feature that are easiest to get
 * silently wrong. A money bug does not throw; it renders a plausible number
 * that is off by a factor of a hundred, which is exactly the defect that
 * appeared once already while building the visual mockup (AI_LOG 32).
 */
/**
 * `Intl` separates the currency code from the amount with a NON-BREAKING SPACE
 * (U+00A0), not an ordinary one, so that "SAR" can never wrap away from its
 * figure. That is correct typography and is deliberately kept - this helper
 * builds the expected string rather than the formatter being made to emit a
 * plain space.
 *
 * The first version of these tests asserted ordinary spaces and failed with
 * "Expected: SAR 1,250.00 / Received: SAR 1,250.00" - two strings that are
 * identical on screen and different in memory.
 */
const money = (parts: string): string => parts.replace(/ /gu, ' ');

describe('F06-T29 money formatting', () => {
  it('renders minor units as major units for a two-decimal currency', () => {
    expect(formatMoney(125_000, 'SAR')).toBe(money('SAR 1,250.00'));
    expect(formatMoney(8_000, 'SAR')).toBe(money('SAR 80.00'));
    expect(formatMoney(296_500, 'SAR')).toBe(money('SAR 2,965.00'));
  });

  it('keeps the currency code attached to its amount', () => {
    // Asserted directly, so the non-breaking space is a decision on the record
    // rather than an accident nobody noticed.
    expect(formatMoney(125_000, 'SAR')).toContain(' ');
    expect(formatMoney(125_000, 'SAR')).not.toContain('SAR 1');
  });

  it('does not divide by 100 for a zero-decimal currency', () => {
    // THE BUG THIS EXISTS TO CATCH. 1000 JPY minor units is 1,000 yen, not
    // 10.00 - JPY has no minor unit. A hard-coded /100 would print "JPY 10.00"
    // and nothing about it would look wrong.
    expect(currencyExponent('JPY')).toBe(0);
    expect(formatMoney(1_000, 'JPY')).toBe(money('JPY 1,000'));
  });

  it('handles zero and the smallest non-zero amount', () => {
    expect(formatMoney(0, 'SAR')).toBe(money('SAR 0.00'));
    // One halala. A naive string split would produce "SAR .01" or "SAR 1.00".
    expect(formatMoney(1, 'SAR')).toBe(money('SAR 0.01'));
    expect(formatMoney(99, 'SAR')).toBe(money('SAR 0.99'));
    expect(formatMoney(100, 'SAR')).toBe(money('SAR 1.00'));
  });

  it('is exact at the top of the int4 range the column allows', () => {
    // 2,147,483,647 minor units is the column's ceiling (R-25). Formatted
    // through the digit string, so there is no float anywhere on the path -
    // and no rounding to be off by.
    expect(formatMoney(2_147_483_647, 'SAR')).toBe(money('SAR 21,474,836.47'));
  });

  it('renders a negative amount with the sign before the code', () => {
    // No expense is negative today (a CHECK constraint forbids it), but the
    // "over by" figure on the detail page is a subtraction, and a subtraction
    // that could ever go the other way must not print "SAR -0.00" style
    // nonsense.
    expect(formatMoney(-75_000, 'SAR')).toBe(money('-SAR 750.00'));
  });

  it('falls back to the raw code for a currency Intl does not know', () => {
    // The amount still has to be right. Showing the code the server actually
    // sent beats guessing a symbol.
    expect(formatMoney(125_000, 'XYZ')).toContain('1,250.00');
    expect(formatMoney(125_000, 'XYZ')).toContain('XYZ');
  });
});

describe('F06-T30 date formatting', () => {
  it('renders in the documented display timezone, not the runner timezone', () => {
    // 2026-11-18T10:00:00Z is 13:00 in Asia/Riyadh (UTC+3). The assertion is
    // deliberately on an instant whose Riyadh date and UTC date agree, so the
    // test is about the OFFSET rather than about a date rollover.
    expect(formatDateTime('2026-11-18T10:00:00.000Z')).toBe('Nov 18, 2026, 13:00');
  });

  it('crosses the date boundary in the display zone, not in UTC', () => {
    // 22:30 UTC is 01:30 the NEXT day in Riyadh. A formatter that fell back to
    // UTC would print Nov 18 here, and the row would sort into a different day
    // from the one it is labelled with.
    expect(formatDateTime('2026-11-18T22:30:00.000Z')).toBe('Nov 19, 2026, 01:30');
    expect(formatDate('2026-11-18T22:30:00.000Z')).toBe('Nov 19, 2026');
  });

  it('renders an unparseable timestamp as a dash, not "Invalid Date"', () => {
    // "Invalid Date" on screen reads as a crash to a person and tells them
    // nothing. The row still renders.
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDate('')).toBe('—');
  });
});

describe('pluralise', () => {
  it('agrees with its count', () => {
    expect(pluralise(0, 'expense')).toBe('0 expenses');
    expect(pluralise(1, 'expense')).toBe('1 expense');
    expect(pluralise(2, 'expense')).toBe('2 expenses');
    expect(pluralise(1_234, 'expense')).toBe('1,234 expenses');
  });
});

describe('F07-F23 money input conversion', () => {
  it('turns typed major units into exact minor units', () => {
    expect(parseMajorUnits('1250.00', 'SAR')).toEqual({ ok: true, amountMinor: 125_000 });
    expect(parseMajorUnits('500', 'SAR')).toEqual({ ok: true, amountMinor: 50_000 });
    expect(parseMajorUnits('0', 'SAR')).toEqual({ ok: true, amountMinor: 0 });
    expect(parseMajorUnits('0.01', 'SAR')).toEqual({ ok: true, amountMinor: 1 });
    expect(parseMajorUnits('  750.5  ', 'SAR')).toEqual({ ok: true, amountMinor: 75_050 });
  });

  it('is exact where float arithmetic is not', () => {
    // THE CASES THIS FUNCTION EXISTS FOR, measured on this runtime rather
    // than assumed. (A first version of this test asserted that
    // `Number('1250.07') * 100` was inexact. It is not - that product is
    // exactly 125007 - and the assertion failed. These three are real.)

    // The product is simply not the integer it should be.
    expect(Number('8.2') * 100).toBe(819.9999999999999);
    expect(Number('1.1') * 100).toBe(110.00000000000001);

    // And rounding does not always rescue it: 1.005 should be 101 minor
    // units. `Math.round` returns 100 - wrong by one, silently, producing a
    // perfectly valid integer the API would accept without complaint.
    expect(Math.round(1.005 * 100)).toBe(100);

    // The string path has none of these problems, because it never
    // multiplies.
    expect(parseMajorUnits('8.2', 'SAR')).toEqual({ ok: true, amountMinor: 820 });
    expect(parseMajorUnits('1.1', 'SAR')).toEqual({ ok: true, amountMinor: 110 });
    // Excess precision is refused rather than guessed at - see the next test.
    expect(parseMajorUnits('1.005', 'SAR').ok).toBe(false);
  });

  it('refuses excess precision instead of rounding it away', () => {
    const tooPrecise = parseMajorUnits('100.005', 'SAR');

    expect(tooPrecise.ok).toBe(false);
    // Storing 100.00 or 100.01 would decide for the manager, and they would
    // never learn which.
    expect(tooPrecise.ok === false && tooPrecise.reason).toContain('2 decimal places');
  });

  it('respects a zero-decimal currency', () => {
    expect(parseMajorUnits('1000', 'JPY')).toEqual({ ok: true, amountMinor: 1_000 });
    expect(parseMajorUnits('10.00', 'JPY').ok).toBe(false);
  });

  it('rejects empty, negative and non-numeric input', () => {
    expect(parseMajorUnits('', 'SAR').ok).toBe(false);
    expect(parseMajorUnits('   ', 'SAR').ok).toBe(false);
    expect(parseMajorUnits('-50', 'SAR').ok).toBe(false);
    expect(parseMajorUnits('abc', 'SAR').ok).toBe(false);
    expect(parseMajorUnits('1,250.00', 'SAR').ok).toBe(false);
    expect(parseMajorUnits('1.2.3', 'SAR').ok).toBe(false);
    expect(parseMajorUnits('1e5', 'SAR').ok).toBe(false);
  });

  it('accepts leading zeros as the same number', () => {
    expect(parseMajorUnits('0500.00', 'SAR')).toEqual({ ok: true, amountMinor: 50_000 });
    expect(parseMajorUnits('000', 'SAR')).toEqual({ ok: true, amountMinor: 0 });
  });

  it('refuses an amount past the safe integer range', () => {
    expect(parseMajorUnits('999999999999999999', 'SAR').ok).toBe(false);
  });

  it('round-trips through the editable string form', () => {
    for (const minor of [0, 1, 99, 100, 125_000, 2_147_483_647]) {
      const text = toMajorUnitString(minor, 'SAR');
      expect(parseMajorUnits(text, 'SAR')).toEqual({ ok: true, amountMinor: minor });
    }

    // And the editable form carries no grouping separators - an input the
    // user cannot type into without fighting it is worse than a plain one.
    expect(toMajorUnitString(125_000, 'SAR')).toBe('1250.00');
    expect(toMajorUnitString(1_000, 'JPY')).toBe('1000');
  });
});
