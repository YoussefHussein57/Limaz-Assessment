import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookIntegrationModule } from '../webhooks/webhook-integration.module';
import { SimulatorController } from './simulator.controller';
import { SimulatorService } from './simulator.service';
import { WebhookEventQueryService } from './webhook-event-query.service';

/**
 * The sandbox payment simulator and the webhook event history (F12).
 *
 * Kept OUT of `AdminModule` even though its routes sit under `/v1/admin`.
 * `AdminModule` is the tenant-provisioning surface - companies, managers,
 * keys - and every route in it exists in every deployment. These do not: the
 * simulator is a demonstration tool that a production deployment switches
 * off. A module boundary that matches the lifecycle makes "what does a
 * production deployment actually expose?" answerable by reading the module
 * list.
 *
 * It imports `WebhookIntegrationModule` for `WebhookIntegrationService`,
 * because signing a request the way the provider would means using the same
 * secret resolution the verifier uses. Reimplementing it here would be a
 * second place for the signing contract to drift from the checking one, and
 * the simulator would pass while a real provider failed.
 *
 * It does NOT import `WebhooksModule`. The simulator reaches the webhook
 * endpoint over HTTP, like any other client, and a direct dependency would
 * make it possible to call the intake service in process - which is the one
 * shortcut that would make the demonstration prove nothing.
 */
@Module({
  imports: [PrismaModule, WebhookIntegrationModule],
  controllers: [SimulatorController],
  providers: [SimulatorService, WebhookEventQueryService],
})
export class SimulatorModule {}
