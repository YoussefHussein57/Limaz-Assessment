import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardSummaryService } from './dashboard-summary.service';
import { DashboardController } from './dashboard.controller';

/**
 * The manager dashboard's aggregate figures.
 *
 * An ordinary module. Unlike `ExpensesModule` there is no seam to fill: this
 * reads what the policy engine already decided and cannot produce a figure
 * that depends on something unbuilt.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DashboardController],
  providers: [DashboardSummaryService],
})
export class DashboardModule {}
