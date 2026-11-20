import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ApiKeyPrincipal } from './principal.types';

/** The header a company backend presents its key in. */
export const API_KEY_HEADER = 'x-api-key';

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /** SHA-256, hex. See PasswordService for why this is not bcrypt. */
  static hash(presentedKey: string): string {
    return createHash('sha256').update(presentedKey).digest('hex');
  }

  /**
   * Resolves a presented key to the company it authenticates, or null.
   *
   * EVERY lifecycle condition lives in the WHERE clause. That is deliberate:
   * an `if (key.revokedAt) throw` after the query is a line a future code path
   * can forget, and forgetting it means a revoked key keeps working. A
   * condition that prevents the row from being returned at all cannot be
   * forgotten by anyone.
   *
   * `status IN (ACTIVE, ROTATING)` is what gives rotation its grace window
   * without any rotation code existing yet: a superseded key keeps working
   * until its expiresAt passes. Issuing and rotating keys is F08; the
   * semantics are enforced here from the start.
   *
   * One shape of failure for every cause - unknown, revoked, expired, wrong
   * status - because telling them apart would tell an attacker which guess was
   * closer.
   */
  async resolve(presentedKey: string): Promise<ApiKeyPrincipal | null> {
    const row = await this.prisma.apiKey.findFirst({
      where: {
        keyHash: ApiKeyService.hash(presentedKey),
        status: { in: ['ACTIVE', 'ROTATING'] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, companyId: true },
    });

    if (!row) {
      return null;
    }

    return { kind: 'api-key', apiKeyId: row.id, companyId: row.companyId };
  }
}
