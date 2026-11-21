/**
 * Money and dates, formatted once and the same way everywhere.
 *
 * Both functions here are PURE and deterministic - they read nothing from the
 * environment - which is what makes them unit-testable and, more importantly,
 * what makes them safe to call on both sides of the server/client line.
 */

/**
 * The timezone every timestamp is displayed in.
 *
 * ---------------------------------------------------------------------------
 * WHY A FIXED ZONE AND NOT THE VIEWER'S
 * ---------------------------------------------------------------------------
 *
 * The dashboard and the expense detail are Server Components: the HTML is
 * built on the server and hydrated in the browser. If the timestamp were
 * formatted in the viewer's zone, the server would produce one string and the
 * browser another, and React would report a hydration mismatch - on every row,
 * for every viewer outside this zone. That is not a styling problem; the
 * component tree is rebuilt.
 *
 * A fixed zone produces the same string in both places, by construction.
 *
 * This zone and not UTC because it is where the company operates, which is the
 * frame a manager reads an expense in. The label is shown next to the
 * timestamp rather than assumed - "13:00" means nothing without it.
 *
 * NOTHING ABOUT CORRECTNESS DEPENDS ON THIS. The API returns absolute ISO-8601
 * instants, the frequency window is measured in absolute time on `spentAt`
 * (ADR-002), and the policy engine never sees a display string. Changing this
 * constant changes what is printed and nothing else.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Riyadh';

/** Short, unambiguous label for the zone above. */
export const DISPLAY_TIME_ZONE_LABEL = 'Riyadh time';

/**
 * The locale every number and date is formatted in.
 *
 * Fixed for the same reason as the zone: `undefined` would resolve to the
 * server's locale on the server and the viewer's in the browser, and the two
 * strings would differ. The application's own language is English, so this is
 * not a localisation decision being dodged - there is one language and this
 * names it.
 */
const LOCALE = 'en-US';

/**
 * How many minor units make one major unit, for this currency.
 *
 * NOT hard-coded to 100. SAR and USD have two decimal places; JPY has none,
 * and `1000` JPY minor units is ¥1,000, not ¥10.00. Dividing by 100 would be
 * wrong by a factor of a hundred for every zero-decimal currency, and the
 * number would still look plausible.
 *
 * `Intl` already knows the answer, so it is asked rather than tabulated.
 */
export function currencyExponent(currency: string): number {
  try {
    const resolved = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
    }).resolvedOptions();

    // The type says this can be undefined, and it is defaulted rather than
    // asserted: a `!` here would be a claim about the runtime that nothing in
    // this file can check.
    return resolved.maximumFractionDigits ?? 2;
  } catch {
    // An unknown or malformed code. Two is the overwhelmingly common case and
    // is what the rest of this system uses; the caller still sees the raw code
    // in the output, so nothing is silently relabelled.
    return 2;
  }
}

/**
 * Formats an integer minor-unit amount for display.
 *
 * ---------------------------------------------------------------------------
 * WHY NO ARITHMETIC HAPPENS HERE
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is `format(amountMinor / 10 ** exponent)`. For
 * this project's value range that happens to be exact - but it is exact by a
 * margin, not by construction, and "it fits in a double" is the kind of
 * reasoning that stops being true one requirement later.
 *
 * So the decimal point is INSERTED INTO THE DIGIT STRING and the string is
 * handed to `Intl.NumberFormat`, which accepts one since ES2023 and parses it
 * at arbitrary precision. No division, no rounding, no floating point
 * anywhere on the path from the database integer to the screen.
 *
 * The stored value is never modified: 125000 SAR minor units is displayed as
 * SAR 1,250.00 and remains 125000 in every request this UI makes.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = amountMinor < 0;
  const digits = Math.abs(amountMinor).toString().padStart(exponent + 1, '0');

  const whole = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  const decimal = `${negative ? '-' : ''}${whole}${fraction}`;

  try {
    return new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      // The ISO code rather than a symbol. "SAR 1,250.00" is unambiguous
      // everywhere; a symbol for a currency the reader does not use is not.
      currencyDisplay: 'code',
      // `StringNumericLiteral` is a template-literal type that a runtime-built
      // string cannot satisfy structurally, so the assertion is unavoidable -
      // but it is SOUND: `decimal` is assembled above from an optional '-',
      // digits, and at most one '.', which is exactly that grammar.
    }).format(decimal as Intl.StringNumericLiteral);
  } catch {
    // An unknown currency code. The amount is still shown correctly, with the
    // code the server actually sent rather than a guessed symbol.
    return `${currency} ${decimal}`;
  }
}

const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat(LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** `18 Nov 2026, 13:00` in the display zone. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);

  // An unparseable timestamp renders as a dash rather than "Invalid Date",
  // which looks like a crash to a reader and tells them nothing.
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}

/** `18 Nov 2026` in the display zone. */
export function formatDate(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? '—' : DATE_ONLY.format(date);
}

/**
 * A minor-unit integer as the decimal string a person edits: 125000 -> "1250.00".
 *
 * The inverse of `parseMajorUnits`. No grouping separators and no currency
 * code, because this goes INTO an `<input>` - a value with commas in it is
 * one the user cannot edit without fighting it.
 */
export function toMajorUnitString(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = amountMinor < 0;
  const digits = Math.abs(amountMinor).toString().padStart(exponent + 1, '0');

  if (exponent === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }

  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** What went wrong with a typed amount, or the exact integer it means. */
export type ParsedAmount =
  | { readonly ok: true; readonly amountMinor: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns what a person typed into an exact integer number of minor units.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS STRING ARITHMETIC AND NOT `Math.round(Number(text) * 100)`
 * ---------------------------------------------------------------------------
 *
 * `Number('1250.07') * 100` is `125006.99999999999`. Rounding happens to save
 * that one - and `Math.round(1.005 * 100)` is 100, not 101. The failures are
 * not rare enough to ignore and they are silent: the request carries a number
 * one minor unit away from what the manager typed, the API accepts it because
 * it is a valid integer, and nothing anywhere reports a problem.
 *
 * So the text is split on its decimal point and the digits are concatenated.
 * No multiplication, no floating point, no rounding - the result is the digits
 * the person typed, read as an integer.
 *
 * EXCESS PRECISION IS REFUSED, not rounded. A manager typing "100.005" for a
 * two-decimal currency means something; silently storing 100.00 or 100.01
 * decides for them, and they would never know which.
 */
export function parseMajorUnits(text: string, currency: string): ParsedAmount {
  const trimmed = text.trim();

  if (trimmed === '') {
    return { ok: false, reason: 'Enter an amount.' };
  }

  // Digits, at most one decimal point, no sign. A limit is never negative,
  // and refusing "-" here is clearer than accepting it and failing later.
  if (!/^\d+(\.\d*)?$/u.test(trimmed)) {
    return { ok: false, reason: 'Use digits only, with at most one decimal point.' };
  }

  const exponent = currencyExponent(currency);
  const [whole = '', fraction = ''] = trimmed.split('.');

  if (fraction.length > exponent) {
    return {
      ok: false,
      reason:
        exponent === 0
          ? `${currency} has no decimal places.`
          : `${currency} has ${exponent} decimal places.`,
    };
  }

  // `padEnd`, not multiplication: "1250.5" becomes "1250" + "50".
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`;
  const amountMinor = Number(digits);

  if (!Number.isSafeInteger(amountMinor)) {
    return { ok: false, reason: 'That amount is too large.' };
  }

  return { ok: true, amountMinor };
}

/** `3 expenses` / `1 expense`. Small, but it is wrong in three places if inlined. */
export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString(LOCALE)} ${count === 1 ? singular : plural}`;
}
