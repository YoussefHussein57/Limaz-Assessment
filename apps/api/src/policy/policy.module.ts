import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';

/**
 * Company policy settings.
 *
 * An ordinary module. It depends on `normaliseCategory` from the expenses
 * feature, but that is a PURE FUNCTION imported directly rather than a
 * provider injected through a module - it reads nothing, holds nothing, and
 * importing `ExpensesModule` here would drag a policy evaluator and an
 * advisory lock into a module that needs neither.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PolicyController],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
