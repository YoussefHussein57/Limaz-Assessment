import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * The cryptography behind card webhook intake (F12).
 *
 * =============================================================================
 * WHY THIS SECRET IS ENCRYPTED, WHEN EVERY OTHER CREDENTIAL HERE IS HASHED
 * =============================================================================
 *
 * API keys and session tokens are stored as SHA-256 hashes, and `ADR-006`
 * defends that at length. The reason it works is that the server is HANDED the
 * full credential on every request: it hashes what arrived and compares. A
 * one-way function is sufficient, and a stolen database yields nothing that
 * can authenticate.
 *
 * HMAC cannot work that way. The provider never sends the secret. It sends a
 * message authentication code computed WITH the secret, and the only way to
 * check it is to compute the same code - which needs the key material itself.
 * There is no hash of the key that can stand in for it: HMAC-SHA256 keyed with
 * `sha256(secret)` is a different function from HMAC-SHA256 keyed with
 * `secret`, so it would simply never match what the provider sent.
 *
 * Hashing the SIGNATURE instead does not help either; the signature changes
 * with every request because it covers the body.
 *
 * So the secret has to be recoverable, and the real question is by whom:
 *
 *   plaintext column  - a database dump is a set of working signing keys
 *   encrypted column  - a dump is inert without a key held somewhere else
 *   external KMS/HSM  - the correct production answer, and an entire
 *                       subsystem the assessment does not ask for
 *
 * The middle one is implemented. `WEBHOOK_ENCRYPTION_KEY` lives in the
 * process environment, never in the database, so an attacker needs both.
 * That is genuinely weaker than hashing and it is recorded as risk R-35
 * rather than presented as equivalent.
 *
 * =============================================================================
 * WHY AES-256-GCM AND NOT AES-256-CBC
 * =============================================================================
 *
 * GCM is AUTHENTICATED. A tampered ciphertext fails the authentication tag
 * and `decrypt` throws, rather than producing a different plaintext.
 *
 * With CBC it would decrypt to garbage, which would then be used as an HMAC
 * key, which would simply fail to verify - and the failure would look exactly
 * like "the provider sent a bad signature". Someone would spend an afternoon
 * on the provider's side of a problem that lives in our database.
 *
 * The additional authenticated data is the COMPANY ID. It is not encrypted;
 * it is bound. Moving company A's ciphertext into company B's row - the
 * injection an attacker with write access would actually try - makes the tag
 * check fail, so a swapped secret is a decryption error rather than a
 * silently working key for the wrong tenant.
 */

const CIPHER = 'aes-256-gcm';

/** 96 bits. The size GCM is specified and optimised for. */
const IV_BYTES = 12;

/** 256 bits of CSPRNG output, like every other secret in this system. */
const SECRET_BYTES = 32;

/** AES-256 needs exactly this many bytes of key. Checked at startup. */
export const ENCRYPTION_KEY_BYTES = 32;

/** A SHA-256 HMAC, lowercase hex: 64 characters, nothing else. */
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u;

export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

/**
 * Decodes `WEBHOOK_ENCRYPTION_KEY`.
 *
 * The env schema has already refused to start the process if this is not 32
 * bytes of base64, so this cannot fail in a running application. It throws
 * rather than returning null anyway, because the alternative is a `!` at
 * every call site protecting an invariant that lives somewhere else.
 */
export function decodeEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');

  if (key.length !== ENCRYPTION_KEY_BYTES) {
    // Deliberately says nothing about the value itself.
    throw new Error(
      `WEBHOOK_ENCRYPTION_KEY must decode to ${ENCRYPTION_KEY_BYTES} bytes, got ${key.length}`,
    );
  }

  return key;
}

/**
 * A new per-company signing secret.
 *
 * The `whsec_` prefix is a convention the industry settled on and it earns its
 * place: a secret pasted into a support conversation announces what it is, so
 * it is recognised and rotated rather than mistaken for an identifier. It
 * takes no part in the HMAC - the whole string including the prefix is the
 * key, because that is what the provider would be configured with.
 */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(SECRET_BYTES).toString('base64url')}`;
}

/**
 * The public identifier the provider sends so we know which secret to use.
 *
 * Random rather than the company's UUID, and that is a deliberate separation:
 * the company id appears in administrator URLs and in error messages, and a
 * value that selects a signing key should not be the same value that appears
 * on a screen. It is still not a secret - it selects a row, it proves nothing
 * - but there is no reason to make it guessable from something else.
 */
export function generateDeliveryId(): string {
  return `whi_${randomBytes(16).toString('base64url')}`;
}

/** Encrypts a signing secret, bound to the company that owns it. */
export function sealSecret(plaintext: string, key: Buffer, companyId: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);

  // Bound, not encrypted. See the class comment: this is what makes a
  // secret copied into another company's row fail to decrypt.
  cipher.setAAD(Buffer.from(companyId, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/**
 * Recovers a signing secret.
 *
 * Throws if the ciphertext, the IV, the tag, the key or the company id is
 * wrong. Every one of those is a real problem that must be loud: a silent
 * fallback would turn "our database is corrupt" into "the provider keeps
 * sending bad signatures".
 */
export function openSecret(sealed: SealedSecret, key: Buffer, companyId: string): string {
  const decipher = createDecipheriv(CIPHER, key, sealed.iv);

  decipher.setAAD(Buffer.from(companyId, 'utf8'));
  decipher.setAuthTag(sealed.authTag);

  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}

/**
 * The exact bytes the provider signs.
 *
 * `${timestamp}.${rawBody}`, with the raw body as RECEIVED - never a value
 * that has been parsed and re-serialised.
 *
 * That is the single most important line in this file. `JSON.parse` followed
 * by `JSON.stringify` is not the identity function: it reorders nothing but
 * normalises whitespace, drops insignificant formatting, re-encodes unicode
 * escapes and renders `1.0` as `1`. Any one of those changes the bytes, and
 * the HMAC is over bytes. A verifier built on the parsed object fails every
 * pretty-printed delivery and - far worse - can be made to verify a body that
 * differs from the one the application then acts on.
 *
 * The timestamp is joined with a dot and a literal, not concatenated: without
 * a separator, timestamp `1` with body `23...` and timestamp `12` with body
 * `3...` produce the same signed string.
 */
export function signedPayload(timestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
}

/** HMAC-SHA256 of the signed payload, lowercase hex. */
export function computeSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(signedPayload(timestamp, rawBody)).digest('hex');
}

/**
 * Compares two signatures without leaking how much of them matched.
 *
 * `===` on strings short-circuits at the first differing character, and the
 * time that takes is measurable across enough requests. An attacker who can
 * submit bodies and measure responses recovers a valid signature one character
 * at a time - roughly 16 x 64 attempts rather than 2^256.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * length oracle, so the SHAPE is checked first and a wrong shape is rejected
 * outright. That leaks only "this was not 64 hex characters", which the
 * sender already knows.
 */
export function signaturesMatch(expected: string, provided: string): boolean {
  if (!SIGNATURE_PATTERN.test(provided)) {
    return false;
  }

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

/** True when the string is a well-formed signature, whatever it signs. */
export function isWellFormedSignature(value: string): boolean {
  return SIGNATURE_PATTERN.test(value);
}
