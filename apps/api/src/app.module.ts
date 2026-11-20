import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { AuthenticationGuard, AuthorizationGuard, CsrfGuard } from './auth/guards';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ExpensesModule } from './expenses/expenses.module';
import { PolicyEngineEvaluator } from './expenses/policy/policy-engine.evaluator';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReviewsModule } from './reviews/reviews.module';

/**
 * The guards are registered GLOBALLY and in this order. Both facts are
 * load-bearing.
 *
 * Global, because the alternative - middleware matched to a path pattern, or
 * @UseGuards() on each controller - fails open. A route added outside the
 * pattern, or a controller where somebody forgot the decorator, is simply
 * unprotected and nothing says so. Here every route is protected the moment it
 * exists, and opening one requires writing @Public() on it, in the place a
 * reviewer of that route will read.
 *
 * The order matters because each guard depends on the previous one's work:
 *
 *   1. CsrfGuard          - cheapest, and the only one that must run before
 *                           authentication: login is @Public(), so if CSRF ran
 *                           after authentication it would never run for login
 *                           at all, leaving login CSRF wide open.
 *   2. AuthenticationGuard - resolves WHO, attaches the principal.
 *   3. AuthorizationGuard  - decides WHAT, and needs the principal to exist.
 *
 * Nest executes APP_GUARD providers in registration order.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthModule,
    HealthModule,
    // F04 activates expense submission. The module cannot be imported without
    // naming a policy evaluator, so the endpoint and the decision engine
    // arrive together or not at all - there is no state in which
    // POST /v1/expenses exists and cannot decide anything.
    ExpensesModule.withEvaluator({ useClass: PolicyEngineEvaluator }),
    // F05: the manager review lifecycle. An ordinary module - unlike expenses
    // it has no dependency that had to exist before the routes could be
    // published.
    ReviewsModule,
    // F06: the manager dashboard's aggregate figures. Read-only, and in its
    // own namespace so `summary` can never be parsed as an expense id.
    DashboardModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
    // One response shape for every error, and no request headers echoed back.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
