import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PasswordService } from '../auth/password.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ManagerSummary } from './admin.types';
import { toManagerSummary } from './admin.types';
import type { CreateManagerDto } from './dto/admin.dto';

/**
 * Provisioning a company's manager accounts (F11, closing R-32).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not a user-management system. There is no deletion, no role editor,
 * no transfer between companies, and no way to create another platform
 * administrator. Every one of those is a wider authority than "set this
 * company up so somebody can review its expenses", and the assessment asks
 * for the latter.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FIELDS THE CALLER CANNOT SET
 * ---------------------------------------------------------------------------
 *
 *   `role`      - always MANAGER, written by this file.
 *   `companyId` - always the company in the PATH, which the guard has already
 *                 established the caller may act on.
 *
 * Neither is read from the request body, and `createManagerSchema` is
 * `.strict()`, so a body carrying either is a 400 rather than a field that is
 * parsed and ignored. That matters more here than anywhere else in the admin
 * module: a request that could set `role: 'PLATFORM_ADMIN'` would be a
 * privilege escalation written in one line of JSON (F11-T10), and one that
 * could set `companyId` would put a manager inside a tenant the administrator
 * never named (F11-T11).
 */
@Injectable()
export class ManagerAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * One company's managers.
   *
   * Safe columns only - `passwordHash` is not in the `select`, so there is no
   * path by which it could reach a response (the F02 lesson, test F02-T28).
   *
   * Bounded at 100. A listing with no limit is an unbounded response waiting
   * for a tenant large enough to produce one.
   */
  async list(companyId: string): Promise<readonly ManagerSummary[]> {
    await this.requireCompany(companyId);

    const rows = await this.prisma.user.findMany({
      where: { companyId, role: 'MANAGER' },
      select: { id: true, email: true, displayName: true, role: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    return rows.map(toManagerSummary);
  }

  /**
   * Creates one manager for the company named in the path.
   *
   * ---------------------------------------------------------------------
   * WHY THE DUPLICATE IS CAUGHT FROM THE DATABASE, NOT BEFORE THE INSERT
   * ---------------------------------------------------------------------
   *
   * `User.email` is globally unique, and a check-then-insert loses the race
   * when two administrators submit the same address at the same moment: both
   * SELECTs find nothing, both INSERTs run, and one of them raises 23505 from
   * inside a path that was not expecting it - which is how this becomes a 500.
   *
   * So the INSERT is the authority and P2002 is translated here. There is no
   * pre-check at all: it would be a second source of truth that is wrong
   * exactly when it matters (F11-T06b).
   *
   * The email is already lowercased by the DTO, with the SAME transform the
   * login schema uses. If the two ever diverged, this endpoint would create
   * an account whose address nobody could type (F11-T07).
   */
  async create(companyId: string, input: CreateManagerDto): Promise<ManagerSummary> {
    await this.requireCompany(companyId);

    // Hashed BEFORE the insert, and the plaintext is never held anywhere else.
    // It is not logged, not returned, and not written to any other column.
    const passwordHash = await this.passwords.hash(input.password);

    try {
      const created = await this.prisma.user.create({
        data: {
          companyId,
          email: input.email,
          displayName: input.displayName,
          passwordHash,
          // Written here, never read from the request. See the class comment.
          role: 'MANAGER',
        },
        select: { id: true, email: true, displayName: true, role: true, createdAt: true },
      });

      return toManagerSummary(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The address is reported back because the caller supplied it and
        // already knows it. This is not the login endpoint, where naming the
        // email would be an enumeration oracle - the caller here is an
        // authenticated platform administrator who can already list accounts.
        throw new ConflictException({
          error: 'conflict',
          message: `An account already exists for ${input.email}.`,
          details: { conflictingField: 'email' },
        });
      }

      throw error;
    }
  }

  /**
   * 404 for a company that does not exist.
   *
   * Checked before anything else so that creating a manager for a mistyped
   * company id fails on the company rather than on the foreign key - the
   * difference between "no such company" and an opaque 500 from PostgreSQL.
   */
  private async requireCompany(companyId: string): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });

    if (!company) {
      throw new NotFoundException({ error: 'not_found', message: 'No such company.' });
    }
  }
}
