import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * F00-T02 (happy path) - requires a reachable PostgreSQL instance.
 *
 *   docker compose up -d db
 *   DATABASE_URL=postgresql://limaz:limaz_dev_only_password@localhost:5433/limaz \
 *     npm test --workspace @limaz/api
 */
describe('GET /health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 200 with the database reported up', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.checks.database.status).toBe('up');
    expect(typeof response.body.checks.database.latencyMs).toBe('number');
    expect(response.body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof response.body.uptimeSeconds).toBe('number');
  });

  it('never returns the connection string', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(JSON.stringify(response.body)).not.toContain('postgresql://');
  });
});
