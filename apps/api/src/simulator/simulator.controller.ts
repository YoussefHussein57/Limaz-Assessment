import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { assertUuid } from '../common/uuid';
import {
  listWebhookEventsSchema,
  simulatePaymentSchema,
} from './dto/simulator.dto';
import { SimulatorService, type SimulationResult } from './simulator.service';
import {
  WebhookEventQueryService,
  type WebhookEventPage,
  type WebhookEventSummary,
} from './webhook-event-query.service';

/**
 * The sandbox simulator and the webhook event history (F12).
 *
 * ---------------------------------------------------------------------------
 * TWO INDEPENDENT GATES, AND BOTH ARE ON THE SERVER
 * ---------------------------------------------------------------------------
 *
 *   1. `@Roles('PLATFORM_ADMIN')` on the CLASS. A company manager is 403, a
 *      company API key is 403 for its kind, an unauthenticated caller is 401.
 *      Same model as every other admin route.
 *
 *   2. `SANDBOX_SIMULATOR_ENABLED`, checked INSIDE the service. A deployment
 *      with the flag off answers 404 even to a genuine administrator.
 *
 * The second is not redundant. The first says who may use a feature; the
 * second says whether the feature exists here at all. An endpoint that can
 * forge a correctly signed provider request should not be reachable in a
 * production deployment by anybody, however privileged - and hiding the
 * navigation link would be presentation, not enforcement.
 *
 * The event HISTORY is not behind the sandbox flag. Reading what the provider
 * actually delivered is an operational question that outlives the
 * demonstration, and it creates nothing.
 */
@Roles('PLATFORM_ADMIN')
@Controller('v1/admin')
export class SimulatorController {
  constructor(
    private readonly simulator: SimulatorService,
    private readonly events: WebhookEventQueryService,
  ) {}

  /** Whether this deployment has a sandbox, so the UI can render honestly. */
  @Get('simulator')
  describeSimulator(): { enabled: boolean; endpoint: string } {
    return {
      enabled: this.simulator.isEnabled(),
      // The path only. Never the host it is posted to, and never a URL the
      // caller could influence.
      endpoint: '/v1/webhooks/card-transactions',
    };
  }

  /**
   * Generates one synthetic card event, signs it, and delivers it to the real
   * webhook endpoint over HTTP.
   *
   * 200 rather than 202: this reports on a delivery that has already
   * finished, including one the endpoint REFUSED. A 4xx here would mean the
   * simulation itself failed, which is a different thing from the webhook
   * endpoint correctly rejecting a deliberately bad signature.
   */
  @Post('simulator/payments')
  async simulate(@Body() body: unknown): Promise<SimulationResult> {
    const parsed = simulatePaymentSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    return this.simulator.simulate(parsed.data);
  }

  @Get('webhook-events')
  async listEvents(@Query() query: unknown): Promise<WebhookEventPage> {
    const parsed = listWebhookEventsSchema.safeParse(query ?? {});

    if (!parsed.success) {
      throw invalidRequest(parsed.error);
    }

    return this.events.list(parsed.data);
  }

  @Get('webhook-events/:eventId')
  async findEvent(@Param('eventId') eventId: string): Promise<WebhookEventSummary> {
    assertUuid(eventId, 'eventId');

    return this.events.findOne(eventId);
  }
}

function invalidRequest(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    message: error.issues
      .map((issue) => {
        const field = issue.path.map(String).join('.');

        return field ? `${field}: ${issue.message}` : issue.message;
      })
      .join('; '),
  });
}
