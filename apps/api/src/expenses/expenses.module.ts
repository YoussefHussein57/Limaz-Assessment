import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExpenseQueryService } from './expense-query.service';
import { ExpenseSubmissionService } from './expense-submission.service';
import { AdvisoryFrequencyLock, FREQUENCY_LOCK } from './frequency-lock';
import { ExpensesController } from './expenses.controller';
import { POLICY_EVALUATOR } from './policy-evaluator.port';

/**
 * Expense submission.
 *
 * DELIBERATELY NOT IMPORTED BY AppModule, and deliberately impossible to
 * import without a decision.
 *
 * There is no default export and no `@Module()` the application can simply
 * add: the only way in is `withEvaluator()`, which forces whoever wires it to
 * name a policy evaluator. That makes "we shipped expenses without the policy
 * engine" a thing somebody has to write down, rather than something that
 * happens by leaving a provider out.
 *
 * In F03 the only caller was the test factory, and the deployed application
 * had no expense endpoint at all. F04 implemented the real evaluator and
 * AppModule now wires
 *
 *   ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator })
 *
 * which is the whole activation. Nothing was undone and no migration was
 * involved, because no row was ever written with a placeholder decision - the
 * `expenses_decision_status_check` constraint would not have stored one.
 *
 * The shape stays as it is: if F05 or a later feature ever imports this
 * module, it still has to name an evaluator. "We shipped expenses without the
 * policy engine" remains something somebody has to write down.
 */
@Module({})
export class ExpensesModule {
  static withEvaluator(evaluator: Omit<Provider, 'provide'>): DynamicModule {
    return {
      module: ExpensesModule,
      imports: [PrismaModule],
      controllers: [ExpensesController],
      providers: [
        ExpenseSubmissionService,
        // F06's manager read routes. They live on the same controller, so
        // they inherit the rule above: there is no way to publish
        // GET /v1/expenses without also naming a policy evaluator. That is
        // the right coupling - a read endpoint over rows that were never
        // evaluated would show decisions nothing produced.
        ExpenseQueryService,
        { provide: POLICY_EVALUATOR, ...evaluator } as Provider,
        // Always the real advisory lock. Declared here rather than inlined in
        // the service so a test can substitute it through `overrideProvider`,
        // which is the only way the frequency negative control can run the
        // production path with the lock absent. There is no flag - a running
        // application cannot reach this.
        AdvisoryFrequencyLock,
        { provide: FREQUENCY_LOCK, useExisting: AdvisoryFrequencyLock },
      ],
      exports: [ExpenseSubmissionService, ExpenseQueryService],
    };
  }
}
