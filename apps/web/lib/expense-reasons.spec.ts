import { presentReason } from './expense-reasons';
import { readPolicySnapshot } from './expense-types';

/** `Intl` joins a currency code to its amount with U+00A0 - see format.spec.ts. */
const money = (parts: string): string => parts.replace(/ /gu, ' ');

/**
 * F06-T31 - reading a `Json` column defensively.
 *
 * `detail` and `policySnapshot` are JSON columns. Their shape is a convention
 * between two deployments, not a compile-time guarantee, and a row written by
 * an older build is a real possibility. Every reader here has to survive that
 * without throwing and without printing `undefined` where a currency amount
 * should be.
 *
 * The unknown-code path cannot be reached from the database today, because
 * `RuleCode` is a PostgreSQL enum with three values - so it is a
 * forward-compatibility guard rather than a live branch, and this is the only
 * place it can be exercised. That is exactly why it is tested here rather than
 * claimed to be browser-verified.
 */
describe('F06-T31 known rule codes', () => {
  it('AMOUNT_LIMIT shows the amount, the limit and the difference', () => {
    const presented = presentReason(
      {
        code: 'AMOUNT_LIMIT',
        decision: 'REVIEW',
        detail: { amountMinor: 125_000, autoApproveLimitMinor: 50_000 },
      },
      'SAR',
    );

    expect(presented.unknown).toBe(false);
    expect(presented.evidence).toEqual([
      { label: 'Expense amount', value: money('SAR 1,250.00') },
      { label: 'Auto-approval limit', value: money('SAR 500.00') },
      // Subtracted as INTEGERS and then formatted. Subtracting the displayed
      // strings would mean parsing two formatted values back into numbers,
      // which is how a rounding error enters a figure that was exact.
      { label: 'Over by', value: money('SAR 750.00') },
    ]);
  });

  it('FREQUENCY says the count includes the current expense', () => {
    const presented = presentReason(
      {
        code: 'FREQUENCY',
        decision: 'REVIEW',
        detail: { countIncludingCurrent: 4, maxCount: 3, windowMinutes: 60 },
      },
      'SAR',
    );

    // Off-by-one matters to a reader: labelling this "previous expenses" would
    // be wrong and would look like a bug in the rule rather than in the label.
    expect(presented.evidence).toContainEqual({
      label: 'Expenses in the window',
      value: '4 (including this one)',
    });
    expect(presented.evidence).toContainEqual({ label: 'Window', value: '1 hour' });
  });

  it('describes a window in whole hours only when it divides evenly', () => {
    const ninety = presentReason(
      { code: 'FREQUENCY', decision: 'REVIEW', detail: { windowMinutes: 90 } },
      'SAR',
    );
    const twoHours = presentReason(
      { code: 'FREQUENCY', decision: 'REVIEW', detail: { windowMinutes: 120 } },
      'SAR',
    );

    expect(ninety.evidence).toContainEqual({ label: 'Window', value: '90 minutes' });
    expect(twoHours.evidence).toContainEqual({ label: 'Window', value: '2 hours' });
  });

  it('BLOCKED_CATEGORY names the category and the list in force at the time', () => {
    const presented = presentReason(
      {
        code: 'BLOCKED_CATEGORY',
        decision: 'REJECT',
        detail: { category: 'GAMBLING', blockedCategories: ['GAMBLING', 'ALCOHOL'] },
      },
      'SAR',
    );

    expect(presented.evidence).toContainEqual({ label: 'Submitted category', value: 'GAMBLING' });
    expect(presented.evidence).toContainEqual({
      label: 'Blocked at the time',
      value: 'GAMBLING, ALCOHOL',
    });
  });
});

describe('F06-T31 malformed and unknown data', () => {
  it('drops fields it cannot read rather than printing undefined', () => {
    const presented = presentReason(
      {
        code: 'AMOUNT_LIMIT',
        decision: 'REVIEW',
        // Written by a build that used a different field name.
        detail: { amount_minor: '125000' },
      },
      'SAR',
    );

    // The title and explanation still render; the evidence is simply empty.
    // A reader loses the numbers, not the page.
    expect(presented.title).toBe('Over the auto-approval limit');
    expect(presented.evidence).toEqual([]);
  });

  it('survives a detail that is null, a string or an array', () => {
    for (const detail of [null, undefined, 'oops', [1, 2, 3], 42]) {
      const presented = presentReason({ code: 'FREQUENCY', decision: 'REVIEW', detail }, 'SAR');

      expect(presented.evidence).toEqual([]);
      expect(presented.title).toBeTruthy();
    }
  });

  it('renders an unknown code with its own evidence instead of crashing', () => {
    const presented = presentReason(
      {
        // A rule added to the backend after this build shipped.
        code: 'MERCHANT_BLOCKLIST',
        decision: 'REJECT',
        detail: { merchant: 'Casino Royale', matchedRuleId: 7, active: true },
      },
      'SAR',
    );

    expect(presented.unknown).toBe(true);
    expect(presented.title).toBe('Merchant blocklist');
    expect(presented.evidence).toEqual([
      { label: 'Merchant', value: 'Casino Royale' },
      { label: 'Matched rule id', value: '7' },
      { label: 'Active', value: 'true' },
    ]);
  });

  it('does not dump nested objects from an unknown code', () => {
    const presented = presentReason(
      {
        code: 'SOMETHING_NEW',
        decision: 'REVIEW',
        detail: { scalar: 'kept', nested: { secret: 'dropped' }, list: ['dropped'] },
      },
      'SAR',
    );

    // Scalars only. A nested object could be anything - including something
    // the API had no intention of publishing - so it is dropped rather than
    // serialised.
    expect(presented.evidence).toEqual([{ label: 'Scalar', value: 'kept' }]);
  });
});

describe('F06-T31 policy snapshot', () => {
  it('reads a well-formed snapshot', () => {
    expect(
      readPolicySnapshot({
        autoApproveLimitMinor: 50_000,
        frequencyMaxCount: 3,
        frequencyWindowMinutes: 60,
        blockedCategories: ['GAMBLING'],
        capturedBy: 'an extra field a newer build added',
      }),
    ).toEqual({
      autoApproveLimitMinor: 50_000,
      frequencyMaxCount: 3,
      frequencyWindowMinutes: 60,
      blockedCategories: ['GAMBLING'],
    });
  });

  it('returns null for anything it cannot read', () => {
    // The page then says "not in a shape this version can display" rather than
    // rendering `undefined` where a limit should be.
    expect(readPolicySnapshot(null)).toBeNull();
    expect(readPolicySnapshot('{}')).toBeNull();
    expect(readPolicySnapshot({})).toBeNull();
    expect(readPolicySnapshot({ autoApproveLimitMinor: '50000' })).toBeNull();
    expect(
      readPolicySnapshot({
        autoApproveLimitMinor: 50_000,
        frequencyMaxCount: 3,
        frequencyWindowMinutes: 60,
        // Not an array.
        blockedCategories: 'GAMBLING',
      }),
    ).toBeNull();
  });

  it('keeps only the string entries of a mixed blocked list', () => {
    const snapshot = readPolicySnapshot({
      autoApproveLimitMinor: 1,
      frequencyMaxCount: 1,
      frequencyWindowMinutes: 1,
      blockedCategories: ['GAMBLING', 7, null, 'ALCOHOL'],
    });

    expect(snapshot?.blockedCategories).toEqual(['GAMBLING', 'ALCOHOL']);
  });
});
