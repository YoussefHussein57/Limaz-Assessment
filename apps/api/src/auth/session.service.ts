import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import type { UserPrincipal } from './principal.types';

export const SESSION_COOKIE_NAME = 'limaz_session';

export interface IssuedSession {
  /** The raw token. Goes into the cookie and is never stored or logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

@Injectable()
export class SessionService {
  private readonly ttlMs: number;
  private readonly cookieSecure: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.ttlMs = env.SESSION_TTL_HOURS * 60 * 60 * 1000;
    this.cookieSecure = env.COOKIE_SECURE;
  }

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Issues a session for a user.
   *
   * 32 bytes from the OS CSPRNG - 256 bits. `Math.random()` is forbidden: it
   * is a non-cryptographic PRNG whose state can be recovered from previous
   * outputs, which would let an attacker predict other users' tokens.
   *
   * Only the SHA-256 hash is stored. A database dump therefore yields hashes,
   * not usable sessions.
   */
  async issue(userId: string): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.prisma.session.create({
      data: { userId, tokenHash: SessionService.hash(token), expiresAt },
    });

    return { token, expiresAt };
  }

  /**
   * Resolves a presented cookie value to the user it authenticates.
   *
   * Expiry and revocation are conditions in the query, not checks after it,
   * for the same reason as API keys: a forgotten `if` is a security hole, a
   * missing row is not.
   *
   * The role and companyId come from the USER row, never from the session and
   * never from the request. A manager always has a company; the platform admin
   * never does - the users_role_company_check constraint from F01 guarantees
   * the database cannot hold any other combination, so the narrowing below is
   * total rather than defensive.
   */
  async resolve(presentedToken: string): Promise<UserPrincipal | null> {
    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash: SessionService.hash(presentedToken),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        user: { select: { id: true, role: true, companyId: true } },
      },
    });

    if (!session) {
      return null;
    }

    const { user } = session;

    if (user.role === 'PLATFORM_ADMIN') {
      return {
        kind: 'user',
        role: 'PLATFORM_ADMIN',
        userId: user.id,
        sessionId: session.id,
        companyId: null,
      };
    }

    if (user.companyId === null) {
      // Unreachable while users_role_company_check exists. If it ever is
      // reached, the constraint has been dropped - fail closed rather than
      // hand out a principal whose tenant filter would read
      // `WHERE companyId = NULL` and quietly match nothing.
      return null;
    }

    return {
      kind: 'user',
      role: 'MANAGER',
      userId: user.id,
      sessionId: session.id,
      companyId: user.companyId,
    };
  }

  /**
   * Revokes one session.
   *
   * Conditional on it still being open, so a replayed logout is a no-op rather
   * than rewriting `revokedAt` and losing when the session actually ended.
   */
  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes every open session for a user. Used by F08 and on password change. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return result.count;
  }

  /**
   * Builds the Set-Cookie header by hand rather than using a cookie library.
   *
   * The attributes are the security boundary, so they are written here where
   * they can be read and asserted on (test F02-T17) instead of being implied
   * by a helper's defaults.
   *
   *   HttpOnly  - JavaScript cannot see the cookie, so an XSS cannot steal it
   *   Secure    - every environment; localhost is a secure context in Chrome
   *               and Firefox, so dev and prod do not diverge
   *   SameSite=Lax - the browser will not attach it to a cross-site POST
   *   Path=/    - sent to the whole API
   *   no Domain - host-only, so it never leaks to a sibling subdomain
   */
  buildSetCookie(token: string, maxAgeSeconds: number): string {
    const parts = [
      `${SESSION_COOKIE_NAME}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${maxAgeSeconds}`,
    ];

    if (this.cookieSecure) {
      parts.splice(1, 0, 'Secure');
    }

    return parts.join('; ');
  }

  /** The same cookie, expired, so the browser drops it. */
  buildClearCookie(): string {
    return this.buildSetCookie('', 0);
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }
}
