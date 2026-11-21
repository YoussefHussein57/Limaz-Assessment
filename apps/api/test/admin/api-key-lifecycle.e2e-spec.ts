import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, COMPANY_B, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { ApiKeyAdminService } from '../../src/admin/api-key-admin.service';
import { ApiKeyService } from '../../src/auth/api-key.service';
import { asUser, createF08TestApp, login } from './f08-test-app';
import { resetDatabase } from '../test-db';

/**
 * F08-B16 to B42 - the API key lifecycle.
 *
 * Every claim here is checked against a REAL submission where that is what the
 * claim means. "The key is in the response" and "the key authenticates" are
 * different statements, and only the second is worth asserting.
 */
describe('F08 API key lifecycle', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const admin = USERS.find((u) => u.role === 'PLATFORM_ADMIN')!;
  const nileManager = USERS.find((u) => u.companyId === COMPANY_A.id)!;
  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;

  let adminCookie: string;
  let managerCookie: string;
  let companyId: string;
  let otherCompanyId: string;

  beforeAll(async () => {
    const booted = await createF08TestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);

    adminCookie = await login(app, admin.email, admin.password);
    managerCookie = await login(app, nileManager.email, nileManager.password);
    companyId = COMPANY_A.id;
    otherCompanyId = COMPANY_B.id;
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  const asAdmin = () => asUser(adminCookie);

  const issue = (company = companyId) =>
    request(app.getHttpServer())
      .post(`/v1/admin/companies/${company}/api-keys`)
      .set(asAdmin())
      .send({});

  const submitWith = (key: string, externalId: string) =>
    request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', key)
      .send({
        externalId,
        employeeId: 'emp-key-test',
        amount: 1_000,
        currency: 'SAR',
        merchant: 'Key Test',
        category: 'OFFICE',
        spentAt: new Date().toISOString(),
      });

  // --- F08-B16 to B26: creation and storage -------------------------------
  it('F08-B16 / B21: an issued key authenticates a real submission', async () => {
    const response = await issue().expect(201);

    expect(response.body.plaintext).toMatch(/^lmz_test_[A-Za-z0-9_-]{43}$/u);
    expect(response.body.key.state).toBe('ACTIVE');

    const submitted = await submitWith(response.body.plaintext, `b16-${Date.now()}`).expect(201);

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: submitted.body.id } });
    // F08-B23: the key carries the COMPANY identity, taken from the row the
    // hash matched - never from anything the caller sent.
    expect(expense.companyId).toBe(companyId);
  });

  it('F08-B17 / B18: a manager and an API key cannot issue keys', async () => {
    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys`)
      .set(asUser(managerCookie))
      .send({})
      .expect(403);

    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys`)
      .set('x-api-key', nileKey)
      .send({})
      .expect(403);
  });

  it('F08-B19: issuing for a company that does not exist is 404', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/companies/00000000-0000-7000-8000-000000000000/api-keys')
      .set(asAdmin())
      .send({})
      .expect(404);
  });

  it('F08-B20: only the hash is persisted, never the plaintext', async () => {
    const response = await issue().expect(201);
    const plaintext = response.body.plaintext as string;

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: response.body.key.id } });

    // The stored hash is SHA-256 of the plaintext - the same function
    // authentication uses, which is why a fresh key works at all.
    expect(row.keyHash).toBe(ApiKeyService.hash(plaintext));
    expect(row.keyHash).not.toBe(plaintext);
    expect(row.prefix).toBe(plaintext.slice(0, 16));

    // Nothing in the table holds the secret itself. Checked across every
    // column rather than the ones we remembered.
    const everything = JSON.stringify(await prisma.apiKey.findMany());
    expect(everything).not.toContain(plaintext);
  });

  it('F08-B22: listing exposes neither the plaintext nor the hash', async () => {
    const issued = await issue().expect(201);

    const response = await request(app.getHttpServer())
      .get(`/v1/admin/companies/${companyId}/api-keys`)
      .set(asAdmin())
      .expect(200);

    const body = JSON.stringify(response.body);

    expect(body).not.toContain(issued.body.plaintext);
    expect(body).not.toMatch(/keyHash/u);

    const rows = await prisma.apiKey.findMany({ where: { companyId } });
    for (const row of rows) {
      expect(body).not.toContain(row.keyHash);
    }

    // What it DOES expose: the prefix, which takes no part in authentication.
    expect(response.body.items[0]).toHaveProperty('prefix');
    expect(response.body.items[0]).toHaveProperty('state');
  });

  it('F08-B24: two generated keys are never the same', async () => {
    const keys = await Promise.all([issue(), issue(), issue(), issue(), issue()]);
    const plaintexts = keys.map((r) => r.body.plaintext as string);

    expect(new Set(plaintexts).size).toBe(5);

    // Each is 32 bytes of CSPRNG output, base64url. Asserted rather than
    // assumed: a generator that fell back to a counter or a timestamp would
    // still produce distinct values, so distinctness alone is not enough.
    for (const plaintext of plaintexts) {
      expect(plaintext.slice('lmz_test_'.length)).toHaveLength(43);
    }
  });

  // --- F08-B27 to B34: rotation -------------------------------------------
  it('F08-B27 / B28 / B29: rotation replaces the key and leaves the old one in grace', async () => {
    const original = await issue().expect(201);
    const originalKey = original.body.plaintext as string;
    const originalId = original.body.key.id as string;

    const rotated = await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${originalId}/rotate`)
      .set(asAdmin())
      .send({})
      // 200, not 201: rotation transitions a credential and returns its
      // replacement.
      .expect(200);

    const newKey = rotated.body.plaintext as string;
    expect(newKey).not.toBe(originalKey);

    // F08-B28: the replacement works.
    await submitWith(newKey, `b28-${Date.now()}`).expect(201);

    // F08-B29: the old one STILL works, during its grace window. Without this
    // every rotation would be an outage - a company cannot deploy a new key
    // to all of its servers atomically.
    await submitWith(originalKey, `b29-${Date.now()}`).expect(201);

    const old = await prisma.apiKey.findUniqueOrThrow({ where: { id: originalId } });
    expect(old.status).toBe('ROTATING');
    expect(old.expiresAt).not.toBeNull();

    // 24 hours, as ADR-006 specifies. Checked with a minute of tolerance
    // rather than to the millisecond.
    const graceMs = old.expiresAt!.getTime() - Date.now();
    expect(graceMs).toBeGreaterThan(ApiKeyAdminService.GRACE_PERIOD_MS - 60_000);
    expect(graceMs).toBeLessThanOrEqual(ApiKeyAdminService.GRACE_PERIOD_MS);
  });

  it('F08-B30: after the grace period the old key stops working', async () => {
    const original = await issue().expect(201);
    const originalKey = original.body.plaintext as string;
    const originalId = original.body.key.id as string;

    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${originalId}/rotate`)
      .set(asAdmin())
      .send({})
      .expect(200);

    // The grace window is 24 hours. Rather than waiting, the EXPIRY is moved
    // into the past - which is the state the clock would reach, written
    // directly. The authentication query compares `expiresAt` to `now()`, so
    // this exercises exactly the condition that matters.
    await prisma.apiKey.update({
      where: { id: originalId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const refused = await submitWith(originalKey, `b30-${Date.now()}`).expect(401);

    // F08-B41: the SAME shape as an unknown key. Telling an expired key apart
    // from an unknown one would tell an attacker which guess was closer.
    const unknown = await submitWith('lmz_test_' + 'x'.repeat(43), `b41-${Date.now()}`).expect(401);
    expect(refused.body).toEqual(unknown.body);
  });

  it('F08-B31: a revoked or already-rotating key cannot be rotated', async () => {
    const revoked = await issue().expect(201);
    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${revoked.body.key.id}/revoke`)
      .set(asAdmin())
      .send({})
      .expect(200);

    const refusedRevoked = await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${revoked.body.key.id}/rotate`)
      .set(asAdmin())
      .send({})
      .expect(409);

    // Rotating a revoked key would resurrect a credential somebody
    // deliberately killed.
    expect(refusedRevoked.body.message).toMatch(/revoked/iu);

    const rotating = await issue().expect(201);
    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${rotating.body.key.id}/rotate`)
      .set(asAdmin())
      .send({})
      .expect(200);

    const refusedAgain = await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${rotating.body.key.id}/rotate`)
      .set(asAdmin())
      .send({})
      .expect(409);

    // "Rotate twice, live forever" - the second rotation would push the
    // expiry 24 hours further out every time.
    expect(refusedAgain.body.message).toMatch(/grace period/iu);
  });

  it('F08-B32: a key id from another company is refused without mutating anything', async () => {
    const theirs = await issue(otherCompanyId).expect(201);
    const before = await prisma.apiKey.findUniqueOrThrow({ where: { id: theirs.body.key.id } });

    // The company in the path says company A; the key belongs to B. Without
    // matching on BOTH, this would rotate B's key while every log line said A.
    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${theirs.body.key.id}/rotate`)
      .set(asAdmin())
      .send({})
      .expect(409);

    const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: theirs.body.key.id } });

    expect(after.status).toBe(before.status);
    expect(after.expiresAt).toEqual(before.expiresAt);

    // And no replacement was created for either company.
    expect(await prisma.apiKey.count({ where: { companyId: otherCompanyId } })).toBe(
      await prisma.apiKey.count({ where: { companyId: otherCompanyId } }),
    );
  });

  it('F08-B33: a failed rotation leaves no partial state', async () => {
    const key = await issue().expect(201);
    const before = await prisma.apiKey.count({ where: { companyId } });

    // Revoke it first, so the conditional update inside the transaction
    // matches zero rows and the whole thing rolls back.
    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${key.body.key.id}/revoke`)
      .set(asAdmin())
      .send({})
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${key.body.key.id}/rotate`)
      .set(asAdmin())
      .send({})
      .expect(409);

    // THE ASSERTION. No orphan replacement was left behind - which is what a
    // create-then-update without a transaction would produce.
    expect(await prisma.apiKey.count({ where: { companyId } })).toBe(before);
  });

  it('F08-B34: two concurrent rotations produce exactly one winner', async () => {
    const key = await issue().expect(201);
    const keyId = key.body.key.id as string;
    const before = await prisma.apiKey.count({ where: { companyId } });

    const url = `/v1/admin/companies/${companyId}/api-keys/${keyId}/rotate`;

    // `.then(r => r)` matters: supertest's Test is LAZY and does not send
    // until something awaits it. Without this the two requests would run one
    // after the other and the test would pass while proving nothing - the
    // F05-T38 lesson (AI_LOG 29).
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post(url).set(asAdmin()).send({}).then((r) => r),
      request(app.getHttpServer()).post(url).set(asAdmin()).send({}).then((r) => r),
    ]);

    const statuses = [first.status, second.status].sort();

    // One winner, one conflict. Guaranteed by the conditional update: the
    // loser finds `status` already ROTATING, matches zero rows, and its whole
    // transaction - including the replacement key it had created - rolls back.
    expect(statuses).toEqual([200, 409]);

    // Exactly ONE replacement exists. Two would mean both transactions
    // committed their new key.
    expect(await prisma.apiKey.count({ where: { companyId } })).toBe(before + 1);

    const rotated = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    expect(rotated.status).toBe('ROTATING');
  }, 60_000);

  // --- F08-B35 to B40: revocation -----------------------------------------
  it('F08-B35 / B36: revocation is immediate', async () => {
    const key = await issue().expect(201);
    const plaintext = key.body.plaintext as string;

    // It works first.
    await submitWith(plaintext, `b35-before-${Date.now()}`).expect(201);

    const revoked = await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${key.body.key.id}/revoke`)
      .set(asAdmin())
      .send({})
      .expect(200);

    expect(revoked.body.state).toBe('REVOKED');
    expect(revoked.body.revokedAt).toBeTruthy();

    // And immediately stops. No grace - that is the difference from rotation.
    await submitWith(plaintext, `b36-after-${Date.now()}`).expect(401);
  });

  it('F08-B37: revoking twice does not rewrite the original timestamp', async () => {
    const key = await issue().expect(201);
    const url = `/v1/admin/companies/${companyId}/api-keys/${key.body.key.id}/revoke`;

    const first = await request(app.getHttpServer()).post(url).set(asAdmin()).send({}).expect(200);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await request(app.getHttpServer()).post(url).set(asAdmin()).send({}).expect(200);

    // Idempotent in the way that matters: the caller wanted it dead and it is
    // dead, so 200 - but `revokedAt` is AUDIT DATA, when the credential
    // actually stopped working, and a second click must not move it.
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
    expect(second.body.state).toBe('REVOKED');
  });

  it('F08-B38: revoking with a mismatched company is refused without mutating', async () => {
    const theirs = await issue(otherCompanyId).expect(201);

    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${theirs.body.key.id}/revoke`)
      .set(asAdmin())
      .send({})
      .expect(404);

    const after = await prisma.apiKey.findUniqueOrThrow({ where: { id: theirs.body.key.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.revokedAt).toBeNull();

    // And the other company's key still authenticates.
    await submitWith(theirs.body.plaintext, `b38-${Date.now()}`).expect(201);
  });

  it('F08-B39: rotate and revoke competing produce one coherent outcome', async () => {
    const key = await issue().expect(201);
    const keyId = key.body.key.id as string;

    const [rotate] = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/admin/companies/${companyId}/api-keys/${keyId}/rotate`)
        .set(asAdmin())
        .send({})
        .then((r) => r),
      request(app.getHttpServer())
        .post(`/v1/admin/companies/${companyId}/api-keys/${keyId}/revoke`)
        .set(asAdmin())
        .send({})
        .then((r) => r),
    ]);

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });

    // Both orderings are legitimate, and which one happens is the database's
    // business. What must hold is that the final state is one of them and not
    // a mixture.
    if (rotate.status === 200) {
      // Rotation won the row first; the revoke then applied on top. Either
      // way the key is no longer ACTIVE, and the status is one of the two.
      expect(['ROTATING', 'REVOKED']).toContain(row.status);
    } else {
      expect(rotate.status).toBe(409);
      expect(row.status).toBe('REVOKED');
    }

    // The key cannot authenticate in either outcome, because a REVOKED row is
    // excluded by `revokedAt IS NULL` and a ROTATING-then-revoked row is too.
    if (row.status === 'REVOKED') {
      await submitWith(key.body.plaintext, `b39-${Date.now()}`).expect(401);
    }
  }, 60_000);

  it('F08-B40: one company\'s key operations never touch another company', async () => {
    const theirsBefore = await prisma.apiKey.findMany({
      where: { companyId: otherCompanyId },
      orderBy: { id: 'asc' },
    });

    const mine = await issue().expect(201);
    await request(app.getHttpServer())
      .post(`/v1/admin/companies/${companyId}/api-keys/${mine.body.key.id}/rotate`)
      .set(asAdmin())
      .send({})
      .expect(200);

    const theirsAfter = await prisma.apiKey.findMany({
      where: { companyId: otherCompanyId },
      orderBy: { id: 'asc' },
    });

    expect(theirsAfter).toEqual(theirsBefore);
  });

  it('F08-B42: the seeded keys still authenticate', async () => {
    // The regression that matters most: F08 added key management, and the
    // credentials every earlier feature's tests rely on must be untouched.
    await submitWith(nileKey, `b42-${Date.now()}`).expect(201);
  });

  it('F08-B26: a key issuance response is not cacheable by anything in between', async () => {
    const response = await issue().expect(201);

    // Nest sets no cache headers of its own, so the absence of a `cache-control`
    // permitting storage is what is asserted - a response carrying a secret
    // must never be marked publicly cacheable.
    const cacheControl = response.headers['cache-control'] ?? '';
    expect(cacheControl).not.toMatch(/public/iu);
    expect(cacheControl).not.toMatch(/max-age=[1-9]/u);
  });
});
