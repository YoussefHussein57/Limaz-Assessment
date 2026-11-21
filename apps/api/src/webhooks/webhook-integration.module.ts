import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookIntegrationService } from './webhook-integration.service';

/**
 * One company's webhook signing secret: provisioning it, and resolving it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE OF ITS OWN
 * ---------------------------------------------------------------------------
 *
 * Three places need it, and only one of them is the webhook pipeline:
 *
 *   `AdminModule`      - an administrator provisions or replaces a secret
 *   `SimulatorModule`  - the sandbox signs a request the way the provider would
 *   `WebhooksModule`   - the verifier resolves the secret to check a signature
 *
 * `WebhooksModule` is DYNAMIC: it needs `ExpenseSubmissionService`, which can
 * only be obtained from `ExpensesModule.withEvaluator(...)`, so importing it
 * means carrying that dynamic module instance around. The other two consumers
 * have no business knowing a policy evaluator exists.
 *
 * Splitting this out keeps the dynamic plumbing confined to the one module
 * that genuinely needs it, and keeps the secret resolution in exactly one
 * place - so the simulator signs with the same code path the verifier checks
 * with, rather than a second implementation that could drift.
 */
@Module({
  imports: [PrismaModule],
  providers: [WebhookIntegrationService],
  exports: [WebhookIntegrationService],
})
export class WebhookIntegrationModule {}
