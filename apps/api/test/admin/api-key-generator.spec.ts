import { environmentToken, generateApiKey } from '../../src/admin/api-key-generator';
import { ApiKeyService } from '../../src/auth/api-key.service';

/**
 * F08-B24b - the key format and its environment label.
 *
 * Pure functions, so no database. The label is cosmetic and nothing
 * authenticates on it - but a WRONG label is worse than none, which is what
 * this suite exists to prevent (AI_LOG 42).
 */
describe('F08 API key generation', () => {
  it('labels a local deployment dev, whatever NODE_ENV says', () => {
    // THE DEFECT THIS CATCHES. The Docker image sets NODE_ENV=production in
    // every environment, because it is a production BUILD - so a developer
    // running `docker compose up` was being handed keys labelled `lmz_prod_`
    // while the seeded keys beside them said `lmz_dev_`.
    expect(environmentToken('production', 'http://localhost:3000')).toBe('dev');
    expect(environmentToken('production', 'http://127.0.0.1:3000')).toBe('dev');
    expect(environmentToken('development', 'http://localhost:3000')).toBe('dev');
  });

  it('labels a real deployment prod', () => {
    expect(environmentToken('production', 'https://expenses.example.com')).toBe('prod');
    expect(environmentToken('development', 'https://expenses.example.com')).toBe('prod');
  });

  it('labels the test suite test', () => {
    expect(environmentToken('test', 'http://localhost:3000')).toBe('test');
  });

  it('falls back to prod for an unparseable origin', () => {
    // Conservative: a key that says prod on a dev box is a nuisance; one that
    // says dev on production is a reason somebody ignores a leak.
    expect(environmentToken('production', 'not a url')).toBe('prod');
    expect(environmentToken('production', '')).toBe('prod');
  });

  it('mints 256 bits of CSPRNG entropy and stores only its hash', () => {
    const key = generateApiKey('test', 'http://localhost:3000', ApiKeyService.hash);

    expect(key.plaintext).toMatch(/^lmz_test_[A-Za-z0-9_-]{43}$/u);
    // 43 base64url characters is 32 bytes.
    expect(key.plaintext.slice('lmz_test_'.length)).toHaveLength(43);

    expect(key.keyHash).toBe(ApiKeyService.hash(key.plaintext));
    expect(key.keyHash).toHaveLength(64);
    expect(key.keyHash).not.toContain(key.plaintext);

    // The prefix is display only and reveals a bounded, fixed slice.
    expect(key.prefix).toBe(key.plaintext.slice(0, 16));
    expect(key.prefix).toHaveLength(16);
  });

  it('never repeats', () => {
    const keys = new Set(
      Array.from({ length: 200 }, () =>
        generateApiKey('test', 'http://localhost:3000', ApiKeyService.hash).plaintext,
      ),
    );

    // Not proof of randomness - a counter would pass this too - but a
    // generator that had collapsed to a constant or a low-entropy source
    // would fail it immediately.
    expect(keys.size).toBe(200);
  });
});
