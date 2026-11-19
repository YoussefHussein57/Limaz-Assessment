import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * F00-T02 (degraded path) - when the database does not answer, /health must
 * return 503 and must not leak the driver error to the caller.
 */
describe('HealthController (database down)', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const failingPrisma = {
      $queryRaw: jest.fn().mockRejectedValue(
        new Error('Authentication failed against database server at `db`, password: `hunter2`'),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService, { provide: PrismaService, useValue: failingPrisma }],
    })
      .setLogger({ log: () => {}, error: () => {}, warn: () => {}, debug: () => {}, verbose: () => {} })
      .compile();

    controller = moduleRef.get(HealthController);
  });

  it('throws 503 Service Unavailable', async () => {
    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports the database as down without leaking driver detail', async () => {
    try {
      await controller.check();
      fail('expected check() to throw');
    } catch (error) {
      const body = (error as ServiceUnavailableException).getResponse();
      const serialised = JSON.stringify(body);

      expect(serialised).toContain('"status":"degraded"');
      expect(serialised).toContain('"database"');
      expect(serialised).toContain('"down"');
      expect(serialised).not.toContain('hunter2');
      expect(serialised).not.toContain('Authentication failed');
    }
  });
});
