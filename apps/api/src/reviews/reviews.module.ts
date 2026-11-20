import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ReviewQueryService } from './review-query.service';
import { ReviewResolutionService } from './review-resolution.service';
import { ReviewsController } from './reviews.controller';

/**
 * The review lifecycle.
 *
 * Unlike `ExpensesModule`, this is an ordinary module with no seam to fill:
 * the expense endpoint could not be published until a policy engine existed,
 * and these routes have no equivalent dependency. Reading and resolving a
 * review needs nothing that is not already built.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ReviewsController],
  providers: [ReviewQueryService, ReviewResolutionService],
  exports: [ReviewQueryService],
})
export class ReviewsModule {}
