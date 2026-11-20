import { Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { AllowCallerTypes, CurrentPrincipal, Public, Roles } from '../../src/auth/decorators';
import type { Principal } from '../../src/auth/principal.types';
import { tenantScope } from '../../src/common/tenant';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * TEST-ONLY controller. It is registered in test modules and is NOT part of
 * AppModule, so it adds no production surface whatsoever.
 *
 * It exists because F02 has to prove behaviour that only becomes visible on
 * protected business routes - a 403 for the wrong role, a 404 for another
 * tenant's row, a rejected companyId override - while the expense, review and
 * admin endpoints are explicitly out of F02's scope.
 *
 * What is scaffolding and what is real matters here:
 *   SCAFFOLDING - these route definitions.
 *   PRODUCTION  - the guards, the decorators, tenantScope(), the principal
 *                 type, and the seeded rows these handlers read.
 *
 * So the mechanism under test is the real one. F03, F05 and F08 re-test tenant
 * isolation on the actual endpoints; this is the first layer, not a substitute.
 */
@Controller('probe')
export class ProbeController {
  constructor(private readonly prisma: PrismaService) {}

  /** Open to anyone, with or without a credential. */
  @Public()
  @Get('public')
  publicRoute(): { ok: true } {
    return { ok: true };
  }

  /** Protected, but accepts either caller type. */
  @Get('any-caller')
  anyCaller(@CurrentPrincipal() principal: Principal): { kind: string } {
    return { kind: principal.kind };
  }

  /** Browser sessions only: an API key must be refused here (F02-T19). */
  @AllowCallerTypes('user')
  @Get('user-only')
  userOnly(@CurrentPrincipal() principal: Principal): { kind: string } {
    return { kind: principal.kind };
  }

  /** Managers only. An admin is also refused - roles are not a hierarchy. */
  @Roles('MANAGER')
  @Get('manager-only')
  managerOnly(): { ok: true } {
    return { ok: true };
  }

  /** Platform admin only. A manager hitting this must get 403 (F02-T12). */
  @Roles('PLATFORM_ADMIN')
  @Get('admin-only')
  adminOnly(): { ok: true } {
    return { ok: true };
  }

  /**
   * A tenant-scoped read over real seeded expenses.
   *
   * The tenant comes from tenantScope(principal) and the id from the path.
   * A row belonging to another company simply does not match, so it is never
   * loaded - and therefore never logged either. The caller gets the same 404
   * as for an id that does not exist anywhere (F02-T13, ADR-003).
   */
  @AllowCallerTypes('user', 'api-key')
  @Get('expenses/:id')
  async readExpense(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ id: string; externalId: string }> {
    const expense = await this.prisma.expense.findFirst({
      where: { id, ...tenantScope(principal) },
      select: { id: true, externalId: true },
    });

    if (!expense) {
      throw new NotFoundException({ error: 'not_found', message: 'Expense not found.' });
    }

    return expense;
  }

  /**
   * A tenant-scoped write.
   *
   * `updateMany` with the tenant in the WHERE rather than `update` by id: the
   * filter is part of the statement, so a row outside the tenant is not
   * updated and the count comes back zero. An `update` by id followed by a
   * check would have already written before anyone looked (F02-T14).
   */
  @AllowCallerTypes('user', 'api-key')
  @Patch('expenses/:id/merchant')
  async renameMerchant(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: { merchant?: string },
  ): Promise<{ updated: number }> {
    const result = await this.prisma.expense.updateMany({
      where: { id, ...tenantScope(principal) },
      data: { merchant: body.merchant ?? 'renamed-by-probe' },
    });

    if (result.count === 0) {
      throw new NotFoundException({ error: 'not_found', message: 'Expense not found.' });
    }

    return { updated: result.count };
  }

  /**
   * Echoes the tenant the server resolved.
   *
   * Used to prove that a companyId in the BODY changes nothing: the answer
   * always comes from the principal (F02-T15).
   */
  @Post('whose-tenant')
  whoseTenant(
    @CurrentPrincipal() principal: Principal,
    @Body() _body: unknown,
  ): { companyId: string | null } {
    return { companyId: principal.companyId };
  }
}
