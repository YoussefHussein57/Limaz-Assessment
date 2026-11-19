import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Owns the single PrismaClient instance and ties its lifecycle to Nest's.
 *
 * Prisma 7 takes a driver adapter rather than a connection string, which is an
 * advantage here rather than a chore: the pg pool is configured explicitly, so
 * `DB_POOL_MAX` is a real, inspectable number instead of a hidden default.
 * Concurrency tests depend on that pool being larger than their concurrency
 * (risk R-10).
 *
 * Connecting in `onModuleInit` means a database that is unreachable at boot
 * surfaces immediately, rather than on the first request that needs it.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        max: env.DB_POOL_MAX,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }
}
