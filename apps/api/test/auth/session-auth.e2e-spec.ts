import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { COMPANY_A, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { TEST_APP_ORIGIN, createAuthTestApp } from './auth-test-app';

const CSRF = 'x-limaz-client';
const COOKIE = 'limaz_session';

const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;

/** Pulls the session token out of a Set-Cookie header. */
function tokenFrom(setCookie: string[] | string | undefined): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = headers.find((h) => h.startsWith(`${COOKIE}=`));
  if (!header) {
    throw new Error('no session cookie was set');
  }
  return header.slice(`${COOKIE}=`.length).split(';')[0]!;
}

describe('F02 user authentication and sessions', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const booted = await createAuthTestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  function login(email: string, password: string) {
    return request(app.getHttpServer())
      .post('/v1/auth/login')
      .set(CSRF, '1')
      .set('origin', TEST_APP_ORIGIN)
      .send({ email, password });
  }

  // --- F02-T07 ---------------------------------------------------------------
  it('F02-T07: a manager logs in and gets a session scoped to their company', async () => {
    const response = await login(nileManager.email, nileManager.password).expect(200);

    expect(response.body.callerType).toBe('user');
    expect(response.body.user.email).toBe(nileManager.email);
    expect(response.body.user.role).toBe('MANAGER');
    expect(response.body.company.id).toBe(COMPANY_A.id);

    const token = tokenFrom(response.headers['set-cookie']);
    expect(token.length).toBeGreaterThan(20);

    // Only the HASH is stored. A database dump yields no usable session.
    const stored = await prisma.session.findFirst({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      select: { id: true, userId: true, revokedAt: true },
    });
    expect(stored).not.toBeNull();
    expect(stored!.revokedAt).toBeNull();

    const raw = await prisma.session.findFirst({ where: { tokenHash: token } });
    expect(raw).toBeNull();
  });

  // --- F02-T08 ---------------------------------------------------------------
  it('F02-T08: wrong password and unknown email give byte-identical 401s', async () => {
    const wrongPassword = await login(nileManager.email, 'definitely-not-the-password');
    const unknownEmail = await login('nobody@nowhere.invalid', nileManager.password);

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);

    // Identical bodies: anything that distinguishes them turns login into an
    // account-enumeration tool.
    expect(JSON.stringify(wrongPassword.body)).toBe(JSON.stringify(unknownEmail.body));
    expect(wrongPassword.body.error).toBe('invalid_credentials');

    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    expect(unknownEmail.headers['set-cookie']).toBeUndefined();
  });

  it('F02-T08b: an unknown email takes comparable time to a wrong password', async () => {
    const timeIt = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await login(email, 'some-password-value');
      return Number(process.hrtime.bigint() - started) / 1_000_000;
    };

    // Warm up, so bcrypt's first-call cost does not land on one sample.
    await timeIt(nileManager.email);

    const known = await timeIt(nileManager.email);
    const unknown = await timeIt('nobody@nowhere.invalid');

    // The point is not a precise ratio - CI timing is noisy - but that the
    // unknown-email path does REAL bcrypt work rather than returning
    // immediately. Without the dummy hash this is typically 100x faster.
    expect(unknown).toBeGreaterThan(known / 5);
  }, 30_000);

  // --- F02-T09 ---------------------------------------------------------------
  it('F02-T09: the platform admin logs in and has no company', async () => {
    const response = await login(admin.email, admin.password).expect(200);

    expect(response.body.user.role).toBe('PLATFORM_ADMIN');
    // Null, not absent: the admin belongs to no tenant, and that has to be a
    // value somebody handles rather than a missing field.
    expect(response.body.company).toBeNull();
  });

  // --- F02-T17 - cookie attributes -------------------------------------------
  it('F02-T17: the session cookie carries every protective attribute', async () => {
    const response = await login(nileManager.email, nileManager.password).expect(200);
    const headers = response.headers['set-cookie'] as unknown as string[];
    const cookie = headers.find((h) => h.startsWith(`${COOKIE}=`))!;

    expect(cookie).toContain('HttpOnly'); // JavaScript cannot read it
    expect(cookie).toContain('Secure'); // https, and localhost counts
    expect(cookie).toContain('SameSite=Lax'); // not sent on cross-site POST
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=28800'); // 8 hours
    expect(cookie).not.toContain('Domain='); // host-only, no subdomain leak
  });

  it('F02-T17b: COOKIE_SECURE=false drops only the Secure flag', async () => {
    const insecure = await createAuthTestApp({ COOKIE_SECURE: 'false' });
    try {
      const response = await request(insecure.app.getHttpServer())
        .post('/v1/auth/login')
        .set(CSRF, '1')
        .send({ email: nileManager.email, password: nileManager.password })
        .expect(200);

      const headers = response.headers['set-cookie'] as unknown as string[];
      const cookie = headers.find((h) => h.startsWith(`${COOKIE}=`))!;

      expect(cookie).not.toContain('Secure');
      // Everything else is unconditional - the escape hatch must not quietly
      // weaken anything beyond the flag it names.
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    } finally {
      await insecure.app.close();
    }
  }, 60_000);

  // --- F02-T10 and F02-T11 ---------------------------------------------------
  it('F02-T10: an expired session is rejected', async () => {
    const response = await login(nileManager.email, nileManager.password).expect(200);
    const token = tokenFrom(response.headers['set-cookie']);
    const tokenHash = createHash('sha256').update(token).digest('hex');

    await prisma.session.updateMany({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('cookie', `${COOKIE}=${token}`)
      .expect(401);
  });

  it('F02-T11: logout revokes the session and a replay is rejected', async () => {
    const loggedIn = await login(nileManager.email, nileManager.password).expect(200);
    const token = tokenFrom(loggedIn.headers['set-cookie']);

    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('cookie', `${COOKIE}=${token}`)
      .expect(200);

    const loggedOut = await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('cookie', `${COOKIE}=${token}`)
      .set(CSRF, '1')
      .set('origin', TEST_APP_ORIGIN)
      .expect(204);

    const cleared = (loggedOut.headers['set-cookie'] as unknown as string[]).find((h) =>
      h.startsWith(`${COOKIE}=`),
    )!;
    expect(cleared).toContain('Max-Age=0');

    // Revocation happened in the DATABASE. Clearing the cookie is only
    // client-side tidying, and the client is free to ignore it - which is
    // exactly why replaying the same token must still fail.
    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('cookie', `${COOKIE}=${token}`)
      .expect(401);

    const stored = await prisma.session.findFirstOrThrow({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      select: { revokedAt: true },
    });
    expect(stored.revokedAt).not.toBeNull();
  });

  // --- F02-T25 and F02-T26 - several sessions --------------------------------
  it('F02-T25: two logins produce independent sessions', async () => {
    const first = tokenFrom((await login(nileManager.email, nileManager.password)).headers['set-cookie']);
    const second = tokenFrom((await login(nileManager.email, nileManager.password)).headers['set-cookie']);

    expect(first).not.toBe(second);

    await request(app.getHttpServer()).get('/v1/auth/me').set('cookie', `${COOKIE}=${first}`).expect(200);
    await request(app.getHttpServer()).get('/v1/auth/me').set('cookie', `${COOKIE}=${second}`).expect(200);
  });

  it('F02-T26: logging out of one session leaves the other working', async () => {
    const laptop = tokenFrom((await login(nileManager.email, nileManager.password)).headers['set-cookie']);
    const phone = tokenFrom((await login(nileManager.email, nileManager.password)).headers['set-cookie']);

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('cookie', `${COOKIE}=${laptop}`)
      .set(CSRF, '1')
      .expect(204);

    await request(app.getHttpServer()).get('/v1/auth/me').set('cookie', `${COOKIE}=${laptop}`).expect(401);
    await request(app.getHttpServer()).get('/v1/auth/me').set('cookie', `${COOKIE}=${phone}`).expect(200);
  });

  // --- F02-T22 - forged and malformed cookies --------------------------------
  it('F02-T22: a forged cookie value is rejected', async () => {
    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('cookie', `${COOKIE}=completely-made-up-token-value`)
      .expect(401);
  });

  it('F02-T22b: a malformed cookie header is rejected, not crashed on', async () => {
    for (const header of [`${COOKIE}`, `${COOKIE}=`, '=value', ';;;', `${COOKIE}=a; ${COOKIE}=b`]) {
      const response = await request(app.getHttpServer()).get('/v1/auth/me').set('cookie', header);
      // Never a 500: bad input is the caller's problem to see as a 401, not
      // ours to leak a stack trace over.
      expect(response.status).toBe(401);
    }
  });

  // --- F02-T23 - ambiguous credentials ---------------------------------------
  it('F02-T23: presenting both an API key and a cookie is refused', async () => {
    const token = tokenFrom((await login(nileManager.email, nileManager.password)).headers['set-cookie']);

    const response = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('cookie', `${COOKIE}=${token}`)
      .set('x-api-key', 'lmz_dev_nile_7Qk2PmXaR4tVbN8cLw3ZyH6dJeF5uG9s')
      .expect(400);

    // Rejected BEFORE either credential is validated, so nothing leaks about
    // whether either was real. Acting as a company and acting as a person are
    // different things, and silently picking one would be a confused deputy.
    expect(response.body.error).toBe('ambiguous_credentials');
  });

  // --- F02-T27 and F02-T28 ---------------------------------------------------
  it('F02-T27: a malformed login body is a 400, never a 500', async () => {
    const bodies: object[] = [{}, { email: 'x' }, { password: 'y' }, { email: 1, password: 2 }, []];

    for (const body of bodies) {
      const response = await request(app.getHttpServer()).post('/v1/auth/login').set(CSRF, '1').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    }
  });

  it('F02-T27b: extra fields in the login body are refused outright', async () => {
    // .strict() on the schema. There is no shape of request in which a
    // caller-supplied companyId, role or userId reaches the service layer.
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set(CSRF, '1')
      .send({
        email: nileManager.email,
        password: nileManager.password,
        role: 'PLATFORM_ADMIN',
        companyId: '00000000-0000-7000-8000-000000000000',
      })
      .expect(400);
  });

  it('F02-T28: no response ever contains a password hash', async () => {
    const loggedIn = await login(nileManager.email, nileManager.password).expect(200);
    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('cookie', `${COOKIE}=${tokenFrom(loggedIn.headers['set-cookie'])}`)
      .expect(200);

    for (const body of [loggedIn.body, me.body]) {
      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('$2b$');
      expect(serialised).not.toContain(nileManager.password);
    }
  });
});
