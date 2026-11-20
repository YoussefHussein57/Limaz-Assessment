import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { API_KEYS, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { REDACTED, redact, redactText } from '../../src/common/redact';
import { createTestPrisma, resetDatabase } from '../test-db';

/**
 * F02-T18 and F02-T24 - what a credential looks like once it has stopped
 * moving.
 *
 * Authentication can be flawless and still leak: a password that reached a
 * log, an API key echoed in an error, a session token written to disk. Those
 * are durable, searchable, and usually visible to people who were never meant
 * to hold them.
 */
describe('F02 credentials at rest', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.$disconnect();
  });

  // --- F02-T18 ---------------------------------------------------------------
  it('F02-T18: no password is stored in plain text', async () => {
    const users = await prisma.user.findMany({
      select: { id: true, passwordHash: true },
    });

    expect(users.length).toBeGreaterThan(0);

    for (const user of users) {
      const fixture = USERS.find((u) => u.id === user.id)!;
      expect(user.passwordHash).not.toBe(fixture.password);
      expect(user.passwordHash).not.toContain(fixture.password);
      // bcrypt modular crypt format, with a real cost factor.
      expect(user.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    }
  });

  it('F02-T18b: no API key is stored in plain text', async () => {
    const keys = await prisma.apiKey.findMany({ select: { id: true, keyHash: true, prefix: true } });

    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      const fixture = API_KEYS.find((k) => k.id === key.id)!;
      expect(key.keyHash).not.toBe(fixture.plaintext);
      expect(key.keyHash).toBe(createHash('sha256').update(fixture.plaintext).digest('hex'));
      // The prefix is for display only and is a strict prefix - enough to
      // identify a key in a support conversation, not enough to use it.
      expect(fixture.plaintext.startsWith(key.prefix)).toBe(true);
      expect(key.prefix.length).toBeLessThan(fixture.plaintext.length / 2);
    }
  });

  it('F02-T18c: no session token is stored in plain text', async () => {
    const token = 'a-known-raw-session-token-value';
    const user = await prisma.user.findFirstOrThrow({ select: { id: true } });

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const raw = await prisma.session.findFirst({ where: { tokenHash: token } });
    expect(raw).toBeNull();

    const hashed = await prisma.session.findFirst({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });
    expect(hashed).not.toBeNull();
  });

  it('F02-T18d: a full dump of the credential columns contains no known secret', async () => {
    // The blunt version of the three tests above: serialise everything that
    // could hold a credential and search it for every secret we know.
    const dump = JSON.stringify([
      await prisma.user.findMany(),
      await prisma.apiKey.findMany(),
      await prisma.session.findMany(),
    ]);

    for (const user of USERS) {
      expect(dump).not.toContain(user.password);
    }
    for (const key of API_KEYS) {
      expect(dump).not.toContain(key.plaintext);
    }
  });

  // --- F02-T24 - redaction ---------------------------------------------------
  describe('F02-T24: redaction before anything is written to a log', () => {
    it('removes credential-bearing headers whatever the surrounding shape', () => {
      const output = redact({
        method: 'POST',
        url: '/v1/auth/login',
        headers: {
          'x-api-key': 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s',
          cookie: 'limaz_session=abc123',
          authorization: 'Bearer something',
          'user-agent': 'curl/8.0',
        },
      }) as Record<string, Record<string, unknown>>;

      expect(output.headers!['x-api-key']).toBe(REDACTED);
      expect(output.headers!.cookie).toBe(REDACTED);
      expect(output.headers!.authorization).toBe(REDACTED);
      // Non-sensitive values survive - a redactor that blanks everything is a
      // redactor people switch off.
      expect(output.headers!['user-agent']).toBe('curl/8.0');
    });

    it('removes secret-bearing keys at any depth', () => {
      const output = redact({
        user: { email: 'a@b.test', password: 'hunter2', passwordHash: '$2b$10$abc' },
        session: { token: 'raw-token', tokenHash: 'deadbeef' },
      }) as Record<string, Record<string, unknown>>;

      expect(output.user!.password).toBe(REDACTED);
      expect(output.user!.passwordHash).toBe(REDACTED);
      expect(output.session!.token).toBe(REDACTED);
      expect(output.session!.tokenHash).toBe(REDACTED);
      expect(output.user!.email).toBe('a@b.test');
    });

    it('removes secrets that travel as bare strings with no key to give them away', () => {
      const key = API_KEYS[0]!.plaintext;
      const line = `auth failed for key ${key} from 10.0.0.1`;

      expect(redactText(line)).not.toContain(key);
      expect(redactText(line)).toContain(REDACTED);
      expect(redactText(line)).toContain('10.0.0.1');
    });

    it('redacts a bcrypt hash appearing inside a message', () => {
      const hash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
      expect(redactText(`compare failed: ${hash}`)).not.toContain(hash);
    });

    it('redacts a password embedded in a connection string, keeping the host', () => {
      // Prisma connection errors quote DATABASE_URL verbatim, and the global
      // exception filter logs the stack of every 500. Without this the
      // database password lands in the application log on the first
      // connection failure.
      const message =
        'Authentication failed against database server, the URL ' +
        'postgresql://limaz:limaz_dev_only_password@db:5432/limaz?schema=public is invalid';

      const output = redactText(message);

      expect(output).not.toContain('limaz_dev_only_password');
      // The diagnosis survives: an error that no longer says which host
      // failed has been redacted into uselessness.
      expect(output).toContain('db:5432');
      expect(output).toContain(REDACTED);
    });

    it('redacts credentials in other URL schemes too', () => {
      for (const url of [
        'postgres://user:s3cret@host/db',
        'redis://default:topsecret@cache:6379',
        'https://admin:letmein@internal.example/health',
      ]) {
        const output = redactText(`connection to ${url} failed`);
        expect(output).not.toMatch(/s3cret|topsecret|letmein/);
      }
    });

    it('redacts credential-bearing prefixes in free text', () => {
      const samples = [
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
        'retrying with api_key=AKIAIOSFODNN7EXAMPLE',
        'password: correct-horse-battery-staple',
      ];

      for (const sample of samples) {
        expect(redactText(sample)).toContain(REDACTED);
      }

      expect(redactText(samples[0]!)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(redactText(samples[2]!)).not.toContain('correct-horse-battery-staple');
    });

    it('leaves an ordinary URL with no credentials alone', () => {
      // A redactor that blanks harmless text is a redactor people switch off.
      const url = 'https://api.example.com/v1/expenses?limit=50';
      expect(redactText(`fetching ${url}`)).toContain(url);
    });

    it('terminates on a cyclic object rather than hanging the logger', () => {
      const cyclic: Record<string, unknown> = { name: 'root' };
      cyclic.self = cyclic;

      // A redactor that hangs while preparing a log line has turned a logging
      // concern into an outage.
      expect(() => redact(cyclic)).not.toThrow();
    });
  });
});
