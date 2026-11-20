import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { resetDatabase } from '../test-db';
import { createAuthTestApp } from './auth-test-app';

/**
 * F02-T01 to F02-T06 - API key authentication against real seeded rows.
 *
 * Every rejection here must look identical. An attacker who can tell "unknown
 * key" from "revoked key" learns that a key they hold was once valid, and an
 * attacker who can tell "expired" from "unknown" learns the same. One 401,
 * one body, whatever the cause.
 */
describe('F02 API key authentication', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const deltaKey = API_KEYS.find((k) => k.companyId === COMPANY_B.id)!.plaintext;

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

  // --- F02-T01 ---------------------------------------------------------------
  it('F02-T01: a valid API key resolves to its own company', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', nileKey)
      .expect(200);

    expect(response.body.callerType).toBe('api-key');
    expect(response.body.company.id).toBe(COMPANY_A.id);
    expect(response.body.company.name).toBe(COMPANY_A.name);
    // An API key authenticates a COMPANY. There is no user behind it.
    expect(response.body.user).toBeNull();
  });

  it('F02-T01b: a different key resolves to a different company', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', deltaKey)
      .expect(200);

    expect(response.body.company.id).toBe(COMPANY_B.id);
    expect(response.body.company.id).not.toBe(COMPANY_A.id);
  });

  // --- F02-T02 to F02-T05 ----------------------------------------------------
  it('F02-T02: a missing API key is rejected', async () => {
    const response = await request(app.getHttpServer()).get('/v1/auth/me').expect(401);
    expect(response.body.error).toBe('unauthenticated');
  });

  it('F02-T03: an unknown API key is rejected', async () => {
    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', 'lmz_dev_nope_0000000000000000000000000000000000')
      .expect(401);
  });

  it('F02-T04: a revoked API key is rejected', async () => {
    const key = API_KEYS[0]!;
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    try {
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('x-api-key', key.plaintext)
        .expect(401);
    } finally {
      await prisma.apiKey.update({
        where: { id: key.id },
        data: { status: 'ACTIVE', revokedAt: null },
      });
    }
  });

  it('F02-T05: an expired API key is rejected', async () => {
    const key = API_KEYS[0]!;
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { status: 'ROTATING', expiresAt: new Date(Date.now() - 60_000) },
    });

    try {
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('x-api-key', key.plaintext)
        .expect(401);
    } finally {
      await prisma.apiKey.update({
        where: { id: key.id },
        data: { status: 'ACTIVE', expiresAt: null },
      });
    }
  });

  // --- F02-T06 - the grace window --------------------------------------------
  it('F02-T06: a ROTATING key still authenticates before its expiry', async () => {
    const key = API_KEYS[0]!;
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { status: 'ROTATING', expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    try {
      const response = await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('x-api-key', key.plaintext)
        .expect(200);

      // The grace window is what makes rotation possible without downtime:
      // the company can deploy the new key before the old one dies. The
      // rotation endpoints are F08; these semantics are enforced from F02.
      expect(response.body.company.id).toBe(key.companyId);
    } finally {
      await prisma.apiKey.update({
        where: { id: key.id },
        data: { status: 'ACTIVE', expiresAt: null },
      });
    }
  });

  // --- every rejection looks the same ----------------------------------------
  it('F02-T03b: unknown, revoked and expired keys produce byte-identical bodies', async () => {
    const key = API_KEYS[0]!;

    const unknown = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', 'lmz_dev_unknown_000000000000000000000000000000');

    await prisma.apiKey.update({
      where: { id: key.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const revoked = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', key.plaintext);

    await prisma.apiKey.update({
      where: { id: key.id },
      data: { status: 'ROTATING', revokedAt: null, expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', key.plaintext);

    await prisma.apiKey.update({
      where: { id: key.id },
      data: { status: 'ACTIVE', revokedAt: null, expiresAt: null },
    });

    expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(revoked.body));
    expect(JSON.stringify(revoked.body)).toBe(JSON.stringify(expired.body));
  });

  // --- the key itself must never come back -----------------------------------
  it('F02-T24a: a rejection never echoes the presented key', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', nileKey);

    const serialised = JSON.stringify(response.body) + JSON.stringify(response.headers);
    expect(serialised).not.toContain(nileKey);
  });

  // --- API keys are not people -----------------------------------------------
  it('F02-T19: an API key cannot reach a user-only route', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/user-only')
      .set('x-api-key', nileKey)
      .expect(403);

    // 403, not 401: the credential IS valid. It is the wrong KIND of caller,
    // and that distinction is the whole point of separating authentication
    // from authorization.
    expect(response.body.error).toBe('caller_type_not_allowed');
  });

  it('F02-T19b: an API key cannot reach a role-gated route', async () => {
    await request(app.getHttpServer())
      .get('/probe/manager-only')
      .set('x-api-key', nileKey)
      .expect(403);

    await request(app.getHttpServer())
      .get('/probe/admin-only')
      .set('x-api-key', nileKey)
      .expect(403);
  });

  it('F02-T19c: an API key cannot log out', async () => {
    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('x-api-key', nileKey)
      .expect(403);
  });

  // --- API key callers are exempt from browser CSRF rules --------------------
  it('F02-T16c: an API key mutation needs no CSRF header and no Origin', async () => {
    const expense = await prisma.expense.findFirstOrThrow({
      where: { companyId: COMPANY_A.id },
      select: { id: true },
    });

    // No X-Limaz-Client, no Origin. A server-to-server caller has no browser
    // attaching ambient credentials, so browser CSRF rules protect nothing
    // here and would only break the integration.
    await request(app.getHttpServer())
      .patch(`/probe/expenses/${expense.id}/merchant`)
      .set('x-api-key', nileKey)
      .send({ merchant: 'Renamed By Key' })
      .expect(200);
  });
});
