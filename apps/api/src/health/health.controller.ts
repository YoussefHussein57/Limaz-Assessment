import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';
import type { HealthResult } from './health.types';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * `200` only when every dependency answers; `503` otherwise, with the same
   * body shape either way.
   *
   * Returning `200` while a dependency is down is worse than having no health
   * endpoint at all: Docker, Compose and any load balancer would route traffic
   * to a process that cannot serve it.
   */
  @Get()
  async check(): Promise<HealthResult> {
    const result = await this.healthService.check();

    if (result.status !== 'ok') {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
