import { createHmac, randomBytes } from 'node:crypto';
import {
  computeSignature,
  decodeEncryptionKey,
  generateDeliveryId,
  generateSigningSecret,
  isWellFormedSignature,
  openSecret,
  sealSecret,
  signaturesMatch,
  signedPayload,
} from '../../src/webhooks/webhook-crypto';

/**
 * F12 - the cryptographic primitives, in isolation.
 *
 * These are unit tests on purpose. The e2e suites prove the endpoint behaves
 * correctly; these prove the properties the endpoint's correctness RESTS on,
 * one at a time, where a failure names the exact thing that broke.
 */
describe('F12 webhook crypto', () => {
  const key = decodeEncryptionKey('bGltYXotdGVzdC13ZWJob29rLWVuYy1rZXktMzJieXQ=');
  const companyId = '0193f0c0-0000-7000-8000-000000000001';

  describe('the encryption key', () => {
    it('F12-U01: accepts exactly 32 bytes', () => {
      expect(key.length).toBe(32);
    });

    it('F12-U02: refuses a key of the wrong length', () => {
      expect(() => decodeEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(
        /32 bytes/u,
      );
    });

    it('F12-U03: never puts the value in the error', () => {
      const short = Buffer.from('too-short').toString('base64');

      try {
        decodeEncryptionKey(short);
        fail('expected it to throw');
      } catch (error) {
        expect((error as Error).message).not.toContain(short);
        expect((error as Error).message).not.toContain('too-short');
      }
    });
  });

  describe('sealing a secret', () => {
    it('F12-U10: a sealed secret round-trips', () => {
      const secret = generateSigningSecret();
      const sealed = sealSecret(secret, key, companyId);

      expect(openSecret(sealed, key, companyId)).toBe(secret);
    });

    it('F12-U11: the ciphertext contains no part of the plaintext', () => {
      const secret = generateSigningSecret();
      const sealed = sealSecret(secret, key, companyId);
      const bytes = sealed.ciphertext.toString('utf8');

      expect(bytes).not.toContain(secret);
      expect(bytes).not.toContain('whsec_');
    });

    it('F12-U12: sealing the same secret twice gives different ciphertext', () => {
      // A fresh IV every time. Without it, identical secrets would produce
      // identical ciphertext and a database dump would reveal which companies
      // share one.
      const secret = generateSigningSecret();
      const a = sealSecret(secret, key, companyId);
      const b = sealSecret(secret, key, companyId);

      expect(a.iv.equals(b.iv)).toBe(false);
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
      expect(openSecret(a, key, companyId)).toBe(openSecret(b, key, companyId));
    });

    it('F12-U13: a secret moved to another company fails to decrypt', () => {
      // The company id is the additional authenticated data. This is the
      // injection somebody with database write access would actually try:
      // copy company A's encrypted secret into company B's row.
      const sealed = sealSecret(generateSigningSecret(), key, companyId);

      expect(() => openSecret(sealed, key, '0193f0c0-0000-7000-8000-000000000002')).toThrow();
    });

    it('F12-U14: a tampered ciphertext fails rather than decrypting to something else', () => {
      // GCM is authenticated. With CBC this would decrypt to garbage, which
      // would then be used as an HMAC key and fail to verify - and the
      // failure would look like "the provider sent a bad signature".
      const sealed = sealSecret(generateSigningSecret(), key, companyId);
      const corrupted = Buffer.from(sealed.ciphertext);

      corrupted[0] = corrupted[0]! ^ 0xff;

      expect(() => openSecret({ ...sealed, ciphertext: corrupted }, key, companyId)).toThrow();
    });

    it('F12-U15: the wrong encryption key fails to decrypt', () => {
      const sealed = sealSecret(generateSigningSecret(), key, companyId);
      const other = randomBytes(32);

      expect(() => openSecret(sealed, other, companyId)).toThrow();
    });
  });

  describe('generated values', () => {
    it('F12-U20: a signing secret is 256 bits, prefixed', () => {
      const secret = generateSigningSecret();

      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
      expect(Buffer.from(secret.slice(6), 'base64url').length).toBe(32);
    });

    it('F12-U21: secrets and delivery ids do not repeat', () => {
      const secrets = new Set(Array.from({ length: 200 }, generateSigningSecret));
      const ids = new Set(Array.from({ length: 200 }, generateDeliveryId));

      expect(secrets.size).toBe(200);
      expect(ids.size).toBe(200);
    });
  });

  describe('the signed payload', () => {
    it('F12-U30: is the timestamp, a dot, and the raw bytes', () => {
      const raw = Buffer.from('{"a":1}', 'utf8');

      expect(signedPayload('1763000000', raw).toString('utf8')).toBe('1763000000.{"a":1}');
    });

    it('F12-U31: the separator prevents a boundary collision', () => {
      // Without a separator, timestamp `1` with body `23{...}` and timestamp
      // `12` with body `3{...}` would produce identical signed strings.
      const a = signedPayload('1', Buffer.from('23x', 'utf8'));
      const b = signedPayload('12', Buffer.from('3x', 'utf8'));

      expect(a.equals(b)).toBe(false);
    });

    it('F12-U32: byte-identical bodies with different formatting differ', () => {
      const compact = Buffer.from(JSON.stringify({ a: 1, b: 2 }), 'utf8');
      const pretty = Buffer.from(JSON.stringify({ a: 1, b: 2 }, null, 2), 'utf8');

      const secret = generateSigningSecret();

      expect(computeSignature(secret, '1', compact)).not.toBe(
        computeSignature(secret, '1', pretty),
      );
    });
  });

  describe('the signature', () => {
    const secret = generateSigningSecret();
    const raw = Buffer.from('{"id":"evt_1"}', 'utf8');
    const timestamp = '1763000000';

    it('F12-U40: agrees with an independent HMAC implementation', () => {
      // Computed here from the standard library, not from the module under
      // test. If both sides came from the same function a mistake would be
      // symmetric and invisible.
      const expected = createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), raw]))
        .digest('hex');

      expect(computeSignature(secret, timestamp, raw)).toBe(expected);
    });

    it('F12-U41: is 64 lowercase hex characters', () => {
      expect(computeSignature(secret, timestamp, raw)).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('F12-U42: changes when any input changes', () => {
      const base = computeSignature(secret, timestamp, raw);

      expect(computeSignature(secret, '1763000001', raw)).not.toBe(base);
      expect(computeSignature(secret, timestamp, Buffer.from('{"id":"evt_2"}', 'utf8'))).not.toBe(
        base,
      );
      expect(computeSignature(generateSigningSecret(), timestamp, raw)).not.toBe(base);
    });

    it('F12-U43: matches itself and nothing else', () => {
      const signature = computeSignature(secret, timestamp, raw);

      expect(signaturesMatch(signature, signature)).toBe(true);
      expect(signaturesMatch(signature, computeSignature(secret, '1', raw))).toBe(false);
    });

    it('F12-U44: rejects a malformed signature without throwing', () => {
      // `timingSafeEqual` throws on a length mismatch, which would itself be
      // a length oracle - so the shape is checked first.
      const signature = computeSignature(secret, timestamp, raw);

      for (const bad of ['', 'nonsense', signature.slice(0, 63), `${signature}00`, signature.toUpperCase()]) {
        expect(signaturesMatch(signature, bad)).toBe(false);
      }
    });

    it('F12-U45: recognises a well-formed signature by shape alone', () => {
      expect(isWellFormedSignature('a'.repeat(64))).toBe(true);
      expect(isWellFormedSignature('A'.repeat(64))).toBe(false);
      expect(isWellFormedSignature('a'.repeat(63))).toBe(false);
      expect(isWellFormedSignature('g'.repeat(64))).toBe(false);
    });
  });
});
