#!/usr/bin/env node
/**
 * Measures the contrast ratio of every design-token pair.
 *
 * Committed rather than run once, so the numbers in the documentation stay
 * verifiable instead of becoming a claim nobody can re-check. Four tokens were
 * changed because of what this printed: three sat within 0.1 of the AA
 * threshold, which passes until a different tool rounds differently.
 *
 *   node scripts/check-contrast.mjs
 */

const relativeLuminance = (hex) => {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    .map((pair) => {
      const value = parseInt(pair, 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const ratio = (a, b) => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * `need` is 4.5 for text (WCAG 1.4.3 AA) and 3.0 for the boundary of a user
 * interface component (1.4.11). Decorative borders have no requirement, which
 * is why there are two border tokens rather than one.
 */
const PAIRS = [
  ['text on background', '#0F172A', '#F8FAFC', 4.5],
  ['text on surface', '#0F172A', '#FFFFFF', 4.5],
  ['secondary on background', '#5A6A80', '#F8FAFC', 4.5],
  ['secondary on surface', '#5A6A80', '#FFFFFF', 4.5],
  ['accent on background', '#2563EB', '#F8FAFC', 4.5],
  ['accent on surface', '#2563EB', '#FFFFFF', 4.5],
  ['inverse on accent', '#FFFFFF', '#2563EB', 4.5],
  ['inverse on accent hover', '#FFFFFF', '#1D4ED8', 4.5],
  ['success on success bg', '#166534', '#DCFCE7', 4.5],
  ['warning on warning bg', '#92400E', '#FEF3C7', 4.5],
  ['danger on danger bg', '#991B1B', '#FEE2E2', 4.5],
  ['input border on background', '#64748B', '#F8FAFC', 3.0],
  ['input border on surface', '#64748B', '#FFFFFF', 3.0],
  ['focus ring on surface', '#2563EB', '#FFFFFF', 3.0],
  ['focus ring on background', '#2563EB', '#F8FAFC', 3.0],
];

let failed = 0;

console.log('PAIR                          FG       BG       RATIO  NEED  RESULT');
console.log('-'.repeat(70));

for (const [name, foreground, background, need] of PAIRS) {
  const measured = ratio(foreground, background);
  const ok = measured >= need;
  if (!ok) failed += 1;

  console.log(
    `${name.padEnd(29)} ${foreground}  ${background}  ${measured.toFixed(2).padStart(5)}  ${need.toFixed(1)}  ${ok ? 'PASS' : '*** FAIL ***'}`,
  );
}

console.log('-'.repeat(70));
console.log(failed === 0 ? `All ${PAIRS.length} pairs meet their target.` : `${failed} FAILED.`);

process.exit(failed === 0 ? 0 : 1);
