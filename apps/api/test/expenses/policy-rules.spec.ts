import type { Policy } from '@prisma/client';
import {
  amountLimitRule,
  blockedCategoryRule,
  decide,
  evaluateRules,
  frequencyRule,
  type RuleContext,
} from '../../src/expenses/policy/policy-rules';

/**
 * F04-T01 to F04-T15 - the three rules and decision precedence.
 *
 * NO DATABASE. The rules are pure functions, so every boundary can be tested
 * exhaustively rather than sampled, and a failure names the rule instead of
 * saying "something in the pipeline is wrong".
 *
 * The frequency WINDOW needs a database and is tested in
 * `frequency-window.e2e-spec.ts`. What is tested here is the comparison once
 * the count is known - two different questions that a single test would
 * conflate.
 */

const policyOf = (overrides: Partial<Policy> = {}): Policy =>
  ({
    id: 'policy-1',
    companyId: 'company-1',
    autoApproveLimitMinor: 50_000,
    frequencyMaxCount: 3,
    frequencyWindowMinutes: 60,
    blockedCategories: ['GAMBLING'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Policy;

const contextOf = (overrides: Partial<RuleContext> = {}): RuleContext => ({
  amountMinor: 10_000,
  category: 'TRANSPORT',
  countIncludingCurrent: 1,
  policy: policyOf(),
  ...overrides,
});

describe('F04 policy rules', () => {
  // --- F04-T01 -------------------------------------------------------------
  it('F04-T01: nothing triggered is APPROVE with no reasons', () => {
    const result = evaluateRules(contextOf());

    expect(result.decision).toBe('APPROVE');
    expect(result.ruleHits).toEqual([]);
  });

  // --- F04-T02 to T04: the amount boundary ---------------------------------
  describe('amount limit', () => {
    it('F04-T02: below the limit does not trigger', () => {
      expect(amountLimitRule(contextOf({ amountMinor: 49_999 }))).toBeNull();
    });

    it('F04-T03: EXACTLY the limit does not trigger', () => {
      // The decisive boundary. "Auto-approve limit" names the largest amount
      // that is still auto-approved, so `>=` would be a different rule - and
      // an off-by-one a company would notice on every expense priced at the
      // cap.
      expect(amountLimitRule(contextOf({ amountMinor: 50_000 }))).toBeNull();
    });

    it('F04-T04: one minor unit above the limit triggers REVIEW', () => {
      const hit = amountLimitRule(contextOf({ amountMinor: 50_001 }));

      expect(hit).not.toBeNull();
      expect(hit!.decision).toBe('REVIEW');
      expect(hit!.ruleCode).toBe('AMOUNT_LIMIT');
      // The shape the seed already uses, so seeded and freshly evaluated rows
      // describe the same rule the same way.
      expect(hit!.detail).toEqual({ autoApproveLimitMinor: 50_000, amountMinor: 50_001 });
    });

    it('a zero limit means every expense is reviewed', () => {
      expect(
        amountLimitRule(
          contextOf({ amountMinor: 1, policy: policyOf({ autoApproveLimitMinor: 0 }) }),
        ),
      ).not.toBeNull();
    });

    it('integer comparison only - no float arithmetic anywhere', () => {
      // 0.1 + 0.2 !== 0.3 in binary floating point. Minor units mean the
      // comparison is between two integers and cannot drift (ADR-005).
      const hit = amountLimitRule(
        contextOf({
          amountMinor: 2_147_483_647,
          policy: policyOf({ autoApproveLimitMinor: 2_147_483_646 }),
        }),
      );

      expect(hit!.detail).toEqual({
        autoApproveLimitMinor: 2_147_483_646,
        amountMinor: 2_147_483_647,
      });
    });
  });

  // --- F04-T05 to T07: blocked category ------------------------------------
  describe('blocked category', () => {
    it('F04-T05: a blocked category triggers REJECT', () => {
      const hit = blockedCategoryRule(contextOf({ category: 'GAMBLING' }));

      expect(hit).not.toBeNull();
      expect(hit!.decision).toBe('REJECT');
      expect(hit!.detail).toEqual({ category: 'GAMBLING', blockedCategories: ['GAMBLING'] });
    });

    it('F04-T06: an empty blocked list never triggers', () => {
      expect(
        blockedCategoryRule(
          contextOf({ category: 'GAMBLING', policy: policyOf({ blockedCategories: [] }) }),
        ),
      ).toBeNull();
    });

    it.each([
      ['lowercase in the policy', 'gambling'],
      ['surrounding whitespace', '  GAMBLING  '],
      ['internal whitespace runs', 'GAMBLING'],
      ['mixed case and padding', ' GamBLing '],
    ])('F04-T07: a policy entry with %s still matches', (_name, stored) => {
      // BOTH sides are normalised by the same function. Without this, a list
      // saved as ' gambling ' from the F08 admin screen would be a policy rule
      // that looks configured and silently does nothing.
      const hit = blockedCategoryRule(
        contextOf({ category: 'GAMBLING', policy: policyOf({ blockedCategories: [stored] }) }),
      );

      expect(hit).not.toBeNull();
      // The evidence keeps the company's OWN value, not the normalised one.
      expect(hit!.detail.blockedCategories).toEqual([stored]);
    });

    it('F04-T07b: equivalent Unicode encodings match', () => {
      // `É` as one code point vs `E` + combining acute. Visually identical.
      const hit = blockedCategoryRule(
        contextOf({
          category: 'CAFÉ',
          policy: policyOf({ blockedCategories: ['CAFÉ'] }),
        }),
      );

      expect(hit).not.toBeNull();
    });

    it('a different category does not match', () => {
      expect(blockedCategoryRule(contextOf({ category: 'TRANSPORT' }))).toBeNull();
    });

    it('a partial match does not count', () => {
      // 'GAMBLING_SUPPLIES' is not 'GAMBLING'. Substring matching would block
      // categories the company never listed.
      expect(blockedCategoryRule(contextOf({ category: 'GAMBLING_SUPPLIES' }))).toBeNull();
    });
  });

  // --- F04-T08 to T10: the frequency boundary ------------------------------
  describe('frequency', () => {
    it('F04-T08: the first qualifying expense does not trigger', () => {
      expect(frequencyRule(contextOf({ countIncludingCurrent: 1 }))).toBeNull();
    });

    it('F04-T09: the third does not trigger - 3 is not greater than 3', () => {
      expect(frequencyRule(contextOf({ countIncludingCurrent: 3 }))).toBeNull();
    });

    it('F04-T10: the fourth triggers REVIEW', () => {
      const hit = frequencyRule(contextOf({ countIncludingCurrent: 4 }));

      expect(hit).not.toBeNull();
      expect(hit!.decision).toBe('REVIEW');
      expect(hit!.detail).toEqual({ windowMinutes: 60, maxCount: 3, countIncludingCurrent: 4 });
    });

    it('a different configured threshold is honoured', () => {
      const policy = policyOf({ frequencyMaxCount: 5, frequencyWindowMinutes: 30 });

      expect(frequencyRule(contextOf({ countIncludingCurrent: 5, policy }))).toBeNull();
      expect(frequencyRule(contextOf({ countIncludingCurrent: 6, policy }))).not.toBeNull();
    });
  });

  // --- F04-T11 to T14: precedence with complete reasons --------------------
  describe('precedence, with every triggered reason retained', () => {
    it('F04-T11: amount + frequency is REVIEW with two reasons', () => {
      const result = evaluateRules(contextOf({ amountMinor: 60_000, countIncludingCurrent: 4 }));

      expect(result.decision).toBe('REVIEW');
      expect(result.ruleHits.map((h) => h.ruleCode)).toEqual(['AMOUNT_LIMIT', 'FREQUENCY']);
    });

    it('F04-T12: amount + blocked category is REJECT with two reasons', () => {
      const result = evaluateRules(contextOf({ amountMinor: 60_000, category: 'GAMBLING' }));

      expect(result.decision).toBe('REJECT');
      expect(result.ruleHits.map((h) => h.ruleCode)).toEqual(['AMOUNT_LIMIT', 'BLOCKED_CATEGORY']);
      // The REVIEW hit is still reported even though REJECT won.
      expect(result.ruleHits.find((h) => h.ruleCode === 'AMOUNT_LIMIT')!.decision).toBe('REVIEW');
    });

    it('F04-T13: frequency + blocked category is REJECT with two reasons', () => {
      const result = evaluateRules(contextOf({ category: 'GAMBLING', countIncludingCurrent: 4 }));

      expect(result.decision).toBe('REJECT');
      expect(result.ruleHits.map((h) => h.ruleCode)).toEqual(['BLOCKED_CATEGORY', 'FREQUENCY']);
    });

    it('F04-T14: all three triggered is REJECT with three reasons', () => {
      const result = evaluateRules(
        contextOf({ amountMinor: 60_000, category: 'GAMBLING', countIncludingCurrent: 4 }),
      );

      expect(result.decision).toBe('REJECT');
      expect(result.ruleHits).toHaveLength(3);
      expect(result.ruleHits.map((h) => h.ruleCode)).toEqual([
        'AMOUNT_LIMIT',
        'BLOCKED_CATEGORY',
        'FREQUENCY',
      ]);
      // The whole point: REJECT carries one piece of information, the
      // evaluation carries three, and a manager reading this later needs all
      // three. Short-circuiting on the blocked category would discard two.
    });

    it('F04-T15: the order rules are evaluated in cannot change the decision', () => {
      const context = contextOf({
        amountMinor: 60_000,
        category: 'GAMBLING',
        countIncludingCurrent: 4,
      });

      const hits = [
        amountLimitRule(context)!,
        blockedCategoryRule(context)!,
        frequencyRule(context)!,
      ];

      // Every permutation of three elements.
      const permutations = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ];

      for (const order of permutations) {
        expect(decide(order.map((i) => hits[i]!))).toBe('REJECT');
      }

      // And the property that makes it true: precedence is a rank table, not
      // the position of a line of code.
      expect(decide([])).toBe('APPROVE');
      expect(decide([hits[0]!])).toBe('REVIEW');
      expect(decide([hits[1]!])).toBe('REJECT');
    });

    it('a lone REVIEW rule does not become REJECT', () => {
      const result = evaluateRules(contextOf({ amountMinor: 60_000 }));

      expect(result.decision).toBe('REVIEW');
      expect(result.ruleHits).toHaveLength(1);
    });

    it('reason order is deterministic and alphabetical by rule code', () => {
      // So the order rows are persisted in is stable, and matches the order
      // the API response sorts them into.
      const result = evaluateRules(
        contextOf({ amountMinor: 60_000, category: 'GAMBLING', countIncludingCurrent: 4 }),
      );

      const codes = result.ruleHits.map((h) => h.ruleCode);
      expect(codes).toEqual([...codes].sort());
    });
  });
});
