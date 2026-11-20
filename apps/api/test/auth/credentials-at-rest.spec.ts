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

    it('redacts a password when the URL has NO username', () => {
      // redis://:secret@host is legal. A pattern requiring at least one
      // character before the colon let this through untouched.
      const output = redactText('connecting to redis://:sup3rs3cret@cache:6379');

      expect(output).not.toContain('sup3rs3cret');
      expect(output).toContain('cache:6379');
    });

    it('redacts the WHOLE password when it contains an @', () => {
      // Stopping at the first '@' redacted only the first half and left the
      // rest in the log.
      const output = redactText('url postgresql://user:pa@ss@db:5432/limaz failed');

      expect(output).not.toContain('pa@ss');
      expect(output).not.toContain('ss@db');
      expect(output).toContain('db:5432');
    });

    it('redacts a short secret that an earlier length floor would have missed', () => {
      // An eight-character minimum meant `password=abc` went straight through.
      for (const sample of ['password=abc', 'token: x1', 'api_key=7']) {
        expect(redactText(sample)).toContain(REDACTED);
      }

      expect(redactText('password=abc')).not.toContain('abc');
    });

    it('covers the credential key names that matter, not only the obvious ones', () => {
      const samples = [
        'client_secret=4f3a9b2c',
        'access_token: ya29.ExampleValue',
        'refresh_token=1//abcdef',
        'x-api-key: ZZZTopSecret',
        'secret=hunter2',
      ];

      for (const sample of samples) {
        const output = redactText(sample);
        expect(output).toContain(REDACTED);
        expect(output).not.toMatch(/4f3a9b2c|ya29|abcdef|ZZZTopSecret|hunter2/);
      }
    });

    it('leaves a URL with a username but no password alone', () => {
      // There is nothing secret in it, and blanking it would remove useful
      // diagnostic detail for no gain.
      const url = 'postgresql://limaz@db:5432/limaz';
      expect(redactText(`connecting to ${url}`)).toContain(url);
    });

    it('truncates very long input instead of scanning it unbounded', () => {
      // Caller-influenced data reaches error messages, so the length is not
      // ours to assume. An unbounded scan turns logging into a stall.
      const huge = `${'a'.repeat(50_000)} postgresql://u:leaked@host/db`;

      const started = Date.now();
      const output = redactText(huge);
      const elapsedMs = Date.now() - started;

      expect(output).toContain('[truncated]');
      expect(output.length).toBeLessThan(10_000);
      expect(elapsedMs).toBeLessThan(500);
    });

    it('never emits half a secret at the truncation boundary', () => {
      // Cutting at an arbitrary index can land inside a connection string,
      // leaving a head that carries no '@' - so nothing redacts it and part of
      // the password is logged anyway.
      const secret = 'thePasswordValue';

      // Walk the boundary across the whole URL, one character at a time.
      for (let pad = 8_100; pad < 8_200; pad += 1) {
        const input = `${'x'.repeat(pad)} postgresql://user:${secret}@db:5432/limaz`;
        const output = redactText(input);

        for (let length = 4; length <= secret.length; length += 1) {
          expect(output).not.toContain(secret.slice(0, length));
        }
      }
    });

    it('redacts a password containing characters that are legal in userinfo', () => {
      // ',' and ';' are sub-delims, so RFC 3986 allows them in a password.
      // Treating them as authority terminators - which an earlier revision did
      // while fixing comma-separated lists - cut the authority short and left
      // the password untouched. This is the regression that fix introduced.
      const cases: Array<[string, string]> = [
        ['postgresql://u:pa,ss@host/db', 'pa,ss'],
        ['postgresql://u:pa;ss@host/db', 'pa;ss'],
        ['redis://:a,b,c@cache:6379', 'a,b,c'],
        // Sub-delims, minus the quotes. Those are a documented limit, because
        // a quote also closes a string in every structured log, and scanning
        // past it would mangle the line instead.
        ['postgresql://u:p!$&()*+,;=@host/db', 'p!$&()*+,;='],
      ];

      for (const [input, secret] of cases) {
        const output = redactText(input);
        expect(output).not.toContain(secret);
        expect(output).toContain(REDACTED);
      }
    });

    it('still splits a list of urls correctly, without that assumption', () => {
      // Lists are handled by looking ahead to where the NEXT scheme begins,
      // which needs no guess about what a password may contain.
      const output = redactText(
        'postgresql://a:pw,1@h1,postgresql://b:pw;2@h2;mysql://c:pw3@h3',
      );

      expect(output).not.toContain('pw,1');
      expect(output).not.toContain('pw;2');
      expect(output).not.toContain('pw3');
      expect(output).toContain('h1');
      expect(output).toContain('h2');
      expect(output).toContain('h3');
      // And the text is still readable rather than mangled.
      expect(output).toContain('postgresql://a:');
      expect(output).toContain('mysql://c:');
    });

    it('drops a url the truncation left half-written', () => {
      // Cutting back to a ',' can land inside userinfo, leaving a head with no
      // '@' that nothing recognises as a credential.
      for (let pad = 8_150; pad <= 8_200; pad += 1) {
        const output = redactText(`${'x,'.repeat(pad / 2)}postgresql://u:LEAKEDVALUE@db/x`);

        for (let length = 3; length <= 'LEAKEDVALUE'.length; length += 1) {
          expect(output).not.toContain('LEAKEDVALUE'.slice(0, length));
        }
      }
    });

    it('redacts comma-separated urls that have NO path', () => {
      // Without ',' as an authority terminator the first authority ran on into
      // the second url, swallowed its scheme, and left its password intact.
      // Verified before the fix: pw2 was emitted unredacted.
      const output = redactText('postgresql://a:pw1@h1,postgresql://b:pw2@h2');

      expect(output).not.toContain('pw1');
      expect(output).not.toContain('pw2');
      expect(output).toContain('h1');
      expect(output).toContain('h2');
    });

    it('never emits a password prefix when the input has no whitespace at all', () => {
      // The whitespace fallback cannot fire here, so the cut used to land
      // inside the password. Nine padding lengths leaked before the fix.
      for (let pad = 8_150; pad <= 8_200; pad += 1) {
        const output = redactText(`${'x'.repeat(pad)}postgresql://u:SECRETVALUE@db/limaz`);

        for (let length = 3; length <= 'SECRETVALUE'.length; length += 1) {
          expect(output).not.toContain('SECRETVALUE'.slice(0, length));
        }
      }
    });

    it('redacts EVERY url in one token, not just the first', () => {
      // A message listing two connection strings separated by a comma is a
      // single whitespace token.
      const output = redactText(
        'tried postgresql://a:firstpw@h1/db,postgresql://b:secondpw@h2/db and failed',
      );

      expect(output).not.toContain('firstpw');
      expect(output).not.toContain('secondpw');
      expect(output).toContain('h1');
      expect(output).toContain('h2');
    });

    it('redacts a quoted key in JSON, which is how structured logs look', () => {
      // An earlier version required the delimiter immediately after the key
      // name, so the closing quote broke the match - and structured logs are
      // JSON.
      const output = redactText(
        '{"user":"nour","password":"hunter2","access_token":"ya29.Example"}',
      );

      expect(output).not.toContain('hunter2');
      expect(output).not.toContain('ya29.Example');
      // The non-secret field survives: a redactor that blanks everything is a
      // redactor people switch off.
      expect(output).toContain('nour');
    });

    it('leaves an ordinary URL with a port and an @ in its path alone', () => {
      // The deliberate limit: scanning past the path separator to catch a raw
      // '/' inside a password would mangle this common shape instead.
      const url = 'https://cdn.example.com:8080/img@2x.png';
      expect(redactText(`fetching ${url}`)).toContain(url);
    });

    it('does not blank ordinary prose that happens to follow a key name', () => {
      // A delimiter is required rather than bare whitespace, so an
      // authentication failure message stays readable.
      expect(redactText('the password is incorrect')).toContain('is incorrect');
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
