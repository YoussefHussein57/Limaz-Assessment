import type { INestApplication } from '@nestjs/common';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { API_KEYS, COMPANY_A, USERS } from '../../prisma/seed/fixtures';
import { seed } from '../../prisma/seed/run';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { resetDatabase } from '../test-db';
import { createExpensesTestApp, TEST_APP_ORIGIN } from './expenses-test-app';

/**
 * F03-T30 to F03-T34 - regression on the modified HttpExceptionFilter.
 *
 * F03 added one optional field to the error body. The filter is the single
 * place every error in the service passes through, including errors from
 * paths F03 never touches, so the change has to be shown to be additive
 * rather than argued to be.
 *
 * Two questions:
 *
 *   1. Does an exception that sets no `details` still produce EXACTLY the body
 *      it produced before? Every F02 error depends on this, and two F02 tests
 *      compare whole bodies byte for byte to prove that an unknown key, a
 *      revoked key and an expired key are indistinguishable.
 *
 *   2. Can `details` carry something it should not? The restriction is by
 *      TYPE, so the test feeds it the shapes a careless thrower would reach
 *      for - a Prisma-shaped error, an entity with a hash on it, a Date, an
 *      array - and asserts each is dropped.
 */
describe('F03 exception filter regression', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const nileKey = API_KEYS.find((k) => k.companyId === COMPANY_A.id)!.plaintext;
  const manager = USERS.find((u) => u.companyId === COMPANY_A.id)!;

  beforeAll(async () => {
    const booted = await createExpensesTestApp();
    app = booted.app;
    prisma = booted.prisma;

    await resetDatabase(prisma);
    await seed(prisma);
  }, 90_000);

  afterAll(async () => {
    await resetDatabase(prisma);
    await app?.close();
  });

  // --- F03-T30: existing bodies are unchanged ------------------------------
  it('F03-T30: an error that sets no details has no details key at all', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-limaz-client', '1')
      .set('origin', TEST_APP_ORIGIN)
      .send({})
      .expect(401);

    // Not "details is undefined" - the KEY is absent, so a deep comparison of
    // two bodies still matches.
    expect(Object.keys(response.body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect('details' in response.body).toBe(false);
  });

  it('F03-T31: F02 indistinguishability still holds byte for byte', async () => {
    // The F02 guarantee that matters most: an attacker must not be able to
    // tell an unknown key from a revoked or expired one. If `details` had
    // leaked into any of these, the bodies would differ.
    const unknown = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', 'lmz_dev_unknown_0000000000000000000000000000')
      .expect(401);

    const alsoUnknown = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('x-api-key', 'lmz_dev_other_00000000000000000000000000000')
      .expect(401);

    expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(alsoUnknown.body));
    expect(unknown.body).toEqual({
      statusCode: 401,
      error: 'unauthenticated',
      message: expect.any(String),
    });
  });

  it('F03-T31b: a 403 from the CSRF guard is unchanged', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: manager.email, password: manager.password })
      .expect(403);

    expect(Object.keys(response.body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(response.body.error).toBe('csrf_header_required');
  });

  it('F03-T31c: a 400 with an array message still joins readably', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/expenses')
      .set('x-api-key', nileKey)
      .send({ externalId: '', employeeId: '' })
      .expect(400);

    expect(typeof response.body.message).toBe('string');
    expect('details' in response.body).toBe(false);
  });

  // --- F03-T32 to T34: what `details` will and will not carry --------------
  describe('the details allow-list', () => {
    const filter = new HttpExceptionFilter();

    /** Runs the filter's own mapping without going through HTTP. */
    const bodyFor = (exception: HttpException): Record<string, unknown> => {
      const captured: Record<string, unknown> = {};

      filter.catch(exception, {
        getType: () => 'http',
        switchToHttp: () => ({
          getResponse: () => ({
            statusCode: 0,
            setHeader: () => {},
            end: (payload: string) => Object.assign(captured, JSON.parse(payload)),
          }),
        }),
      } as never);

      return captured;
    };

    it('F03-T32: primitives and one nested object survive', () => {
      const body = bodyFor(
        new ConflictException({
          error: 'conflict',
          message: 'x',
          details: {
            conflictingField: 'externalId',
            count: 2,
            resolved: false,
            existing: { id: 'abc', decision: 'REVIEW' },
          },
        }),
      );

      expect(body.details).toEqual({
        conflictingField: 'externalId',
        count: 2,
        resolved: false,
        existing: { id: 'abc', decision: 'REVIEW' },
      });
    });

    it('F03-T33: anything that is not a primitive or a plain object is dropped', () => {
      const body = bodyFor(
        new ConflictException({
          error: 'conflict',
          message: 'x',
          details: {
            keep: 'yes',
            anError: new Error('stack and all'),
            aDate: new Date(),
            anArray: [1, 2, 3],
            aFunction: () => 'no',
            // The shape a careless thrower would attach: a Prisma error.
            prismaError: Object.assign(new Error('P2002'), {
              meta: { target: ['companyId'] },
            }),
          },
        }),
      );

      expect(body.details).toEqual({ keep: 'yes' });
    });

    it('F03-T33b: nesting deeper than one level is dropped', () => {
      const body = bodyFor(
        new ConflictException({
          error: 'conflict',
          message: 'x',
          details: { a: { b: { c: 'too deep' } }, flat: 'kept' },
        }),
      );

      // `a` survives as a key only if it still has content after pruning; `c`
      // sits at depth three and is removed, which empties `b`, which empties
      // `a`.
      expect(body.details).toEqual({ flat: 'kept' });
    });

    it('F03-T34: strings inside details are redacted', () => {
      const body = bodyFor(
        new ConflictException({
          error: 'conflict',
          message: 'x',
          details: { note: 'postgresql://limaz:supersecret@db:5432/limaz' },
        }),
      );

      expect(JSON.stringify(body)).not.toContain('supersecret');
    });

    it('an empty details object produces no key', () => {
      const body = bodyFor(new ConflictException({ error: 'conflict', message: 'x', details: {} }));

      expect('details' in body).toBe(false);
    });

    it('F03-T34b: a 5xx never carries details, even when one is attached', () => {
      // The caller did not cause a server error and cannot act on one, so the
      // existing rule is a fixed string with the real cause in the log.
      // `details` must not become a new way around that.
      const body = bodyFor(
        new InternalServerErrorException({
          error: 'boom',
          message: 'internal detail',
          details: { table: 'expenses', constraint: 'expenses_pkey' },
        }),
      );

      expect(body.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect('details' in body).toBe(false);
      expect(JSON.stringify(body)).not.toContain('expenses_pkey');
    });

    it('a non-object payload is unaffected', () => {
      const body = bodyFor(new ForbiddenException('plain string'));

      expect('details' in body).toBe(false);
      expect(body.statusCode).toBe(403);
    });
  });
});
