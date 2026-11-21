import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ApiKeyService } from '../auth/api-key.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { generateApiKey } from './api-key-generator';
import { toApiKeySummary, type ApiKeySummary, type IssuedApiKey } from './admin.types';

/**
 * The API key lifecycle (ADR-006).
 *
 * ---------------------------------------------------------------------------
 * THE COMPANY IN THE PATH IS A SELECTOR, NOT AN AUTHORISATION
 * ---------------------------------------------------------------------------
 *
 * Every method takes both a `companyId` and, where relevant, a `keyId`, and
 * every query matches on BOTH. The caller has already been established as a
 * platform administrator by the guard; the company id only says which company
 * to act on.
 *
 * Matching on both is still load-bearing. Without it,
 * `POST /v1/admin/companies/<A>/api-keys/<a key of B>/revoke` would revoke
 * B's key while every log line said A - an administrator could break a company
 * they were not looking at, and the audit trail would point at the wrong one
 * (F08-B32, F08-B38).
 */
@Injectable()
export class ApiKeyAdminService {
  /**
   * The grace window from ADR-006: a superseded key keeps working for 24
   * hours so a company can roll the new one out across its servers without
   * every rotation being an outage.
   */
  static readonly GRACE_PERIOD_MS = 24 * 60 * 60 * 1_000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Safe metadata only. No plaintext, and never the stored hash. */
  async list(companyId: string): Promise<readonly ApiKeySummary[]> {
    await this.requireCompany(companyId);

    const rows = await this.prisma.apiKey.findMany({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Bounded. A company accumulating thousands of rotated keys must not be
      // able to produce an unbounded response.
      take: 100,
    });

    return rows.map(toApiKeySummary);
  }

  /** Issues an additional key. The plaintext is returned once. */
  async issue(companyId: string): Promise<IssuedApiKey> {
    await this.requireCompany(companyId);

    const generated = generateApiKey(this.env.NODE_ENV, this.env.APP_ORIGIN, ApiKeyService.hash);

    const created = await this.prisma.apiKey.create({
      data: {
        companyId,
        keyHash: generated.keyHash,
        prefix: generated.prefix,
        status: 'ACTIVE',
      },
    });

    // Returned only AFTER the row exists. Returning before would hand out a
    // credential that authenticates nothing.
    return { key: toApiKeySummary(created), plaintext: generated.plaintext };
  }

  /**
   * Replaces a key, giving the old one a grace window.
   *
   * ---------------------------------------------------------------------
   * WHY BOTH WRITES ARE IN ONE TRANSACTION
   * ---------------------------------------------------------------------
   *
   * Two failure shapes, and they are not symmetrical:
   *
   *   - the new key is created and the old one is NOT retired: the company
   *     now has two permanently active keys, one of which everybody believes
   *     is on its way out. A credential that was supposed to stop working
   *     silently does not.
   *   - the old key is retired and the new one is NOT created: the company
   *     loses access in 24 hours with no replacement, and nobody is told.
   *
   * In one transaction neither state is reachable. Either rotation happened
   * or nothing did (F08-B33).
   *
   * ---------------------------------------------------------------------
   * WHY A CONDITIONAL UPDATE RATHER THAN AN ADVISORY LOCK
   * ---------------------------------------------------------------------
   *
   * The invariant is ONE ROW changing state - exactly what a row lock and a
   * predicate re-check protect, which is the F05 lesson. The retire step is
   *
   *     updateMany({ where: { id, companyId, status: 'ACTIVE', revokedAt: null } })
   *
   * so a second concurrent rotation finds `status` already `ROTATING`, matches
   * zero rows, and the whole transaction rolls back - including its new key.
   * Exactly one rotation wins (F08-B34).
   *
   * An advisory lock would serialise unrelated keys for no gain. F04 needs one
   * because its invariant is a COUNT across many rows; this one is not.
   *
   * ---------------------------------------------------------------------
   * WHY ONLY AN ACTIVE KEY MAY BE ROTATED
   * ---------------------------------------------------------------------
   *
   * Rotating a REVOKED key would resurrect a credential somebody deliberately
   * killed. Rotating an already-ROTATING one would extend a lifetime that was
   * already counting down - "rotate twice, live forever". Both are refused
   * with 409 rather than quietly doing something defensible-looking
   * (F08-B31).
   */
  async rotate(companyId: string, keyId: string): Promise<IssuedApiKey> {
    await this.requireCompany(companyId);

    const generated = generateApiKey(this.env.NODE_ENV, this.env.APP_ORIGIN, ApiKeyService.hash);
    const expiresAt = new Date(Date.now() + ApiKeyAdminService.GRACE_PERIOD_MS);

    const result = await this.prisma.$transaction(async (tx) => {
      // The tenant guard and the eligibility guard in the SAME WHERE clause.
      // Checking them separately opens a gap between the check and the write.
      const retired = await tx.apiKey.updateMany({
        where: { id: keyId, companyId, status: 'ACTIVE', revokedAt: null },
        data: { status: 'ROTATING', expiresAt },
      });

      if (retired.count === 0) {
        return null;
      }

      const created = await tx.apiKey.create({
        data: {
          companyId,
          keyHash: generated.keyHash,
          prefix: generated.prefix,
          status: 'ACTIVE',
        },
      });

      return created;
    });

    if (result === null) {
      // Zero rows is three different things, and they get one answer because
      // the caller's next action is the same for all three: look at the key
      // list. `explain` names which it was, without inventing a state.
      throw new ConflictException({
        error: 'api_key_not_rotatable',
        message: await this.explain(companyId, keyId, 'rotated'),
      });
    }

    return { key: toApiKeySummary(result), plaintext: generated.plaintext };
  }

  /**
   * Revokes a key immediately. No grace window - that is the point.
   *
   * Rotation is for a planned replacement; revocation is for a leaked
   * credential, where every extra minute is the problem. ADR-006 keeps them
   * separate for that reason, and the UI must not make them look
   * interchangeable.
   *
   * ---------------------------------------------------------------------
   * WHAT REVOCATION DOES NOT DO
   * ---------------------------------------------------------------------
   *
   * It does not cancel a request already in flight. Authentication resolves
   * the key at the start of a request; one that passed that check a
   * millisecond before this commits will finish. The guarantee is that every
   * SUBSEQUENT authentication attempt fails - because `ApiKeyService.resolve`
   * has `revokedAt: null` inside its WHERE clause, so a revoked row cannot be
   * returned at all (F08-B36).
   *
   * Claiming more than that would be claiming a request-cancellation
   * mechanism this system does not have.
   */
  async revoke(companyId: string, keyId: string): Promise<ApiKeySummary> {
    await this.requireCompany(companyId);

    const revokedAt = new Date();

    const result = await this.prisma.apiKey.updateMany({
      // `status: { not: 'REVOKED' }` makes this idempotent in the only way
      // that matters: revoking twice does not overwrite the ORIGINAL
      // `revokedAt`. That timestamp is audit data - when the credential
      // actually stopped working - and a second click must not rewrite it
      // (F08-B37).
      where: { id: keyId, companyId, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED', revokedAt },
    });

    const row = await this.prisma.apiKey.findFirst({ where: { id: keyId, companyId } });

    if (!row) {
      throw new NotFoundException({ error: 'not_found', message: 'No such API key.' });
    }

    // `result.count === 0` with the row present means it was already revoked.
    // That is a successful outcome, not a conflict: the caller wanted it dead
    // and it is dead. The response carries the ORIGINAL revocation time.
    void result;

    return toApiKeySummary(row);
  }

  /** 404 for a company that does not exist, before anything else is attempted. */
  private async requireCompany(companyId: string): Promise<void> {
    const exists = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException({ error: 'not_found', message: 'No such company.' });
    }
  }

  /**
   * Why a lifecycle mutation matched nothing.
   *
   * Runs only on the failure path, and only after the company is known to
   * exist. It reports the key's ACTUAL state rather than guessing, so the
   * message cannot describe a state the database is not in.
   */
  private async explain(companyId: string, keyId: string, verb: string): Promise<string> {
    const row = await this.prisma.apiKey.findFirst({ where: { id: keyId, companyId } });

    if (!row) {
      // Including "for this company": the key id may be real and belong to
      // somebody else, and an administrator needs to know they are looking at
      // the wrong company rather than at a vanished key.
      return `No such API key for this company, so it cannot be ${verb}.`;
    }

    if (row.status === 'REVOKED' || row.revokedAt !== null) {
      return `This key was revoked and cannot be ${verb}. Issue a new key instead.`;
    }

    if (row.status === 'ROTATING') {
      return `This key has already been rotated and is in its grace period. It cannot be ${verb} again.`;
    }

    return `This key cannot be ${verb} in its current state.`;
  }
}
