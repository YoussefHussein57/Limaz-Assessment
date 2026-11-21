import { Module, type DynamicModule } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookIntakeService } from './webhook-intake.service';
import { WebhookIntegrationModule } from './webhook-integration.module';
import { WebhookProcessorService } from './webhook-processor.service';
import { WebhookWorkerService } from './webhook-worker.service';
import { WebhooksController } from './webhooks.controller';

/**
 * Card webhook intake (F12).
 *
 * ---------------------------------------------------------------------------
 * DYNAMIC, AND NOT FOR FASHION
 * ---------------------------------------------------------------------------
 *
 * The processor calls `ExpenseSubmissionService` - the same entry point a
 * company's own backend reaches through `POST /v1/expenses` - so a card
 * transaction goes through the identical policy evaluation, the identical
 * idempotency guarantee and the identical review lifecycle. There is no
 * second engine and no second set of rules to drift.
 *
 * That service only exists inside `ExpensesModule.withEvaluator(...)`, which
 * is deliberately impossible to import without naming a policy evaluator. So
 * this module takes **that exact module instance** as an argument rather than
 * building its own:
 *
 *   const expenses = ExpensesModule.withEvaluator({ useClass: ... });
 *   imports: [expenses, WebhooksModule.forExpenses(expenses)]
 *
 * Passing the same object is what makes Nest reuse one instance. Calling
 * `withEvaluator` twice would compile and run, and would quietly give the
 * webhook pipeline its own `ExpenseSubmissionService` - which is not a
 * correctness bug today, because the service is stateless, but it is exactly
 * the kind of "two of the thing that was supposed to be one" this module
 * exists to avoid.
 */
@Module({})
export class WebhooksModule {
  static forExpenses(expenses: DynamicModule): DynamicModule {
    return {
      module: WebhooksModule,
      imports: [PrismaModule, WebhookIntegrationModule, expenses],
      controllers: [WebhooksController],
      providers: [WebhookIntakeService, WebhookProcessorService, WebhookWorkerService],
      // Exported for the test harness, which drives the worker one event at a
      // time so that "the event was processed" is an assertion rather than a
      // sleep. Nothing in the running application imports them.
      exports: [WebhookProcessorService, WebhookWorkerService],
    };
  }
}
