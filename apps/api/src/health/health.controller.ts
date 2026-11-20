import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators';
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
  /**
   * Public by necessity: Docker, Compose and any load balancer poll this
   * before the service has a caller, and they hold no credential.
   *
   * It is also why the body is so plain. An unauthenticated endpoint that
   * echoed a driver error would publish the database password to anyone who
   * can reach the port, which is why HealthService returns a fixed string and
   * logs the detail server-side only.
   */
  @Public()
  @Get()
  async check(): Promise<HealthResult> {
    const result = await this.healthService.check();

    if (result.status !== 'ok') {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
