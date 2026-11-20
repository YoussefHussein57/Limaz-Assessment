import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExpenseSubmissionService } from './expense-submission.service';
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
 * In F03 the only caller is the test factory. F04 implements the real
 * evaluator and adds
 *
 *   ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator })
 *
 * to AppModule. Nothing here is undone, and no migration is involved, because
 * no row was ever written with a placeholder decision - the
 * `expenses_decision_status_check` constraint would not have stored one.
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
        { provide: POLICY_EVALUATOR, ...evaluator } as Provider,
      ],
      exports: [ExpenseSubmissionService],
    };
  }
}
