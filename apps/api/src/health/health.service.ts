import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { DatabaseCheck, HealthResult } from './health.types';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthResult> {
    const database = await this.checkDatabase();

    return {
      status: database.status === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks: { database },
    };
  }

  /**
   * Issues a real query rather than inspecting a cached connection flag. A
   * pooled connection can be stale; `SELECT 1` is the cheapest proof that the
   * database is genuinely answering right now.
   */
  private async checkDatabase(): Promise<DatabaseCheck> {
    const startedAt = process.hrtime.bigint();

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const elapsedNs = process.hrtime.bigint() - startedAt;
      const latencyMs = Number(elapsedNs) / 1_000_000;

      return { status: 'up', latencyMs: Math.round(latencyMs * 100) / 100 };
    } catch (error) {
      // Logged in full server-side; never returned to the caller. Prisma
      // connection errors frequently contain the DATABASE_URL, password
      // included, so echoing them would leak a credential over HTTP.
      this.logger.error('Database health check failed', error instanceof Error ? error.stack : '');

      return { status: 'down', error: 'database unreachable' };
    }
  }
}
