import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiKeyService } from '../auth/api-key.service';
import { decodeCursor, encodeCursor } from '../common/keyset';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { normaliseBlockedCategories } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { generateApiKey } from './api-key-generator';
import type { CompanyDetail, CompanyPage, IssuedApiKey } from './admin.types';
import { toApiKeySummary } from './admin.types';
import type { CreateCompanyDto, ListCompaniesDto } from './dto/admin.dto';

/**
 * Companies, from an administrator's side.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT TENANT-SCOPED, AND WHY THAT IS NOT A HOLE
 * ---------------------------------------------------------------------------
 *
 * Every other service in this codebase puts `companyId` from the session into
 * its WHERE clause. These queries deliberately do not: an administrator's
 * whole job is to see across companies, and `tenantScope()` would throw for
 * them anyway, because a platform admin has `companyId: null` by construction.
 *
 * The authority therefore comes entirely from the ROLE, checked by
 * `AuthorizationGuard` before any of this runs. A `companyId` in a path
 * parameter here is a SELECTOR, never a proof of anything - it names which
 * company to act on, after the caller has already been established as an
 * administrator. That distinction is the whole security model of this module,
 * and it is the one a reader should check first.
 */
@Injectable()
export class CompanyAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * One page of companies, newest first.
   *
   * Keyset over `(createdAt DESC, id DESC)`, the same shape as every other
   * listing here. The company set only ever GROWS, so offset would repeat
   * rows under a reader exactly as it would on the expense listing.
   */
  async list(query: ListCompaniesDto): Promise<CompanyPage> {
    const where: Prisma.CompanyWhereInput = {
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.cursor ? keysetBefore(query.cursor) : {}),
    };

    const rows = await this.prisma.company.findMany({
      where,
      include: { _count: { select: { apiKeys: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    // How many keys can authenticate RIGHT NOW - which is not the same as how
    // many rows exist. One grouped query for the whole page rather than one
    // per company, so this stays two statements however long the page is.
    const active = await this.countActiveKeys(page.map((row) => row.id));

    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        currency: row.currency,
        createdAt: row.createdAt.toISOString(),
        activeApiKeys: active.get(row.id) ?? 0,
      })),
      nextCursor: hasMore && last ? encodeCursor({ timestamp: last.createdAt, id: last.id }) : null,
    };
  }

  async findOne(companyId: string): Promise<CompanyDetail> {
    const row = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        policy: true,
        _count: { select: { apiKeys: true, users: true } },
      },
    });

    if (!row) {
      throw new NotFoundException({ error: 'not_found', message: 'No such company.' });
    }

    const active = await this.countActiveKeys([row.id]);

    return {
      id: row.id,
      name: row.name,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      activeApiKeys: active.get(row.id) ?? 0,
      policy: row.policy
        ? {
            autoApproveLimitMinor: row.policy.autoApproveLimitMinor,
            frequencyMaxCount: row.policy.frequencyMaxCount,
            frequencyWindowMinutes: row.policy.frequencyWindowMinutes,
            blockedCategories: [...row.policy.blockedCategories].sort(),
          }
        : null,
      managerCount: row._count.users,
    };
  }

  /**
   * Creates a company, its policy and its first API key.
   *
   * ---------------------------------------------------------------------
   * ONE TRANSACTION, AND WHY IT HAS TO BE
   * ---------------------------------------------------------------------
   *
   * Three writes that are meaningless apart:
   *
   *   - a company with no policy accepts expense submissions and cannot
   *     decide any of them. `ExpenseSubmissionService` reads the policy inside
   *     its transaction and has no defined behaviour without one
   *   - a company with no key cannot be reached by its own backend
   *
   * If any write fails, none of them happened. The alternative - three
   * sequential calls - leaves a half-created tenant that looks fine in a
   * listing and fails on first use, and nothing in the system would report it
   * (F08-B10).
   *
   * The raw key is generated BEFORE the transaction and returned only after
   * it commits. Generating inside would be equally correct; returning before
   * the commit would hand out a credential for a company that may not exist.
   */
  async create(input: CreateCompanyDto): Promise<{ company: CompanyDetail; apiKey: IssuedApiKey }> {
    const generated = generateApiKey(this.env.NODE_ENV, this.env.APP_ORIGIN, ApiKeyService.hash);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.create({
          data: {
            name: input.name,
            currency: input.currency,
            policy: {
              create: {
                autoApproveLimitMinor: input.autoApproveLimitMinor,
                frequencyMaxCount: input.frequencyMaxCount,
                frequencyWindowMinutes: input.frequencyWindowMinutes,
                // The SAME normaliser the expense pipeline and F07 use.
                // A third implementation is a third chance for the blocked
                // list to stop matching what arrives.
                blockedCategories: normaliseBlockedCategories(input.blockedCategories),
              },
            },
          },
        });

        const apiKey = await tx.apiKey.create({
          data: {
            companyId: company.id,
            keyHash: generated.keyHash,
            prefix: generated.prefix,
            status: 'ACTIVE',
          },
        });

        return { companyId: company.id, apiKey };
      });

      return {
        company: await this.findOne(created.companyId),
        apiKey: { key: toApiKeySummary(created.apiKey), plaintext: generated.plaintext },
      };
    } catch (error) {
      // 23505 is a unique violation. `keyHash` is the only UNIQUE constraint
      // these writes can trip, and hitting it means 32 bytes of CSPRNG output
      // collided - which will not happen, but answering 500 with a stack
      // trace if it ever did is worse than answering a conflict.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          error: 'conflict',
          message: 'Could not create the company. Try again.',
        });
      }

      throw error;
    }
  }

  /**
   * How many of each company's keys can authenticate right now.
   *
   * The predicate is the SAME one `ApiKeyService.resolve` uses. A count that
   * said "2 active" while only one key worked would be worse than no count:
   * an administrator would stop looking for the problem.
   */
  private async countActiveKeys(companyIds: readonly string[]): Promise<Map<string, number>> {
    if (companyIds.length === 0) {
      return new Map();
    }

    const grouped = await this.prisma.apiKey.groupBy({
      by: ['companyId'],
      where: {
        companyId: { in: [...companyIds] },
        status: { in: ['ACTIVE', 'ROTATING'] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _count: { _all: true },
    });

    return new Map(grouped.map((row) => [row.companyId, row._count._all]));
  }
}

/** `(createdAt, id) < (cursorCreatedAt, cursorId)`, expanded for Prisma. */
function keysetBefore(cursor: string): Prisma.CompanyWhereInput {
  const { timestamp: createdAt, id } = decodeCursor(cursor);

  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
  };
}
