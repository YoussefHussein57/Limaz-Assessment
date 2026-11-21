import { randomBytes } from 'node:crypto';

/**
 * Minting an API key (ADR-006).
 *
 * ---------------------------------------------------------------------------
 * WHY `randomBytes` AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * `crypto.randomBytes` draws from the operating system CSPRNG. Everything else
 * that looks convenient is disqualified, and not narrowly:
 *
 *   `Math.random()`  - a non-cryptographic PRNG whose internal state can be
 *                      recovered from a handful of previous outputs. Anyone
 *                      who has seen a few keys can predict the next.
 *   `Date.now()`     - guessable to the millisecond by anyone who knows
 *                      roughly when a key was issued.
 *   a UUID           - v4 is random but only 122 bits, and v7 embeds a
 *                      timestamp, which is the opposite of what a secret
 *                      wants.
 *
 * 32 bytes is 256 bits. That is the number that justifies SHA-256 rather than
 * bcrypt for storage: brute force is not in the threat model, so a slow hash
 * buys nothing while making an indexed lookup impossible (ADR-006).
 */

/** 32 bytes -> 43 base64url characters, no padding. */
const SECRET_BYTES = 32;

/** First 16 characters, matching `prefixOf` in the seed. */
const PREFIX_LENGTH = 16;

export interface GeneratedApiKey {
  /** The full secret. Returned to the caller ONCE and never stored. */
  readonly plaintext: string;
  /** SHA-256 of the plaintext, hex. This is what the database holds. */
  readonly keyHash: string;
  /** Display only. Takes no part in authentication. */
  readonly prefix: string;
}

/**
 * The environment token inside the key.
 *
 * Cosmetic - nothing authenticates on it - but it exists so a key pasted into
 * a support conversation announces which DEPLOYMENT it belongs to, and nobody
 * wastes an afternoon on a development key that was never going to work
 * against production.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `NODE_ENV`, WHICH IS THE OBVIOUS ANSWER
 * ---------------------------------------------------------------------------
 *
 * The first version used it, and it was wrong in exactly the way that defeats
 * the purpose above. `NODE_ENV=production` means "this is a production
 * BUILD" - and the Docker image sets it in every environment, including a
 * developer running `docker compose up` on their laptop. So a development
 * stack minted keys labelled `lmz_prod_` while its seeded keys said
 * `lmz_dev_`: the token was actively misleading, which is worse than not
 * having one. Caught by reading a key the UI had just issued (AI_LOG 42).
 *
 * `APP_ORIGIN` names the deployment rather than the build, so it is the
 * honest signal. The limitation is real and narrow: a staging deployment on a
 * non-local host reads `prod`. That is a label, not a capability - the key
 * still only works where its hash is stored.
 */
export function environmentToken(nodeEnv: string, appOrigin: string): string {
  // The test suite runs against a local origin too, so this is checked first.
  if (nodeEnv === 'test') {
    return 'test';
  }

  let host = '';

  try {
    host = new URL(appOrigin).hostname;
  } catch {
    // An unparseable origin should not decide a label. Fall through to the
    // conservative answer below.
  }

  return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'dev' : 'prod';
}

/**
 * Mints a key. The plaintext exists only in the returned object.
 *
 * `hashKey` is passed in rather than imported, so this module has no
 * dependency on the auth feature and the hash used for storage is provably
 * the same function authentication uses - a second implementation would mean
 * a freshly issued key that cannot authenticate.
 */
export function generateApiKey(
  nodeEnv: string,
  appOrigin: string,
  hashKey: (value: string) => string,
): GeneratedApiKey {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const plaintext = `lmz_${environmentToken(nodeEnv, appOrigin)}_${secret}`;

  return {
    plaintext,
    keyHash: hashKey(plaintext),
    prefix: plaintext.slice(0, PREFIX_LENGTH),
  };
}
