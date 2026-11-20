import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import type { Principal, UserPrincipal } from './principal.types';
import { type IssuedSession, SessionService } from './session.service';

export interface AuthenticatedIdentity {
  readonly callerType: 'api-key' | 'user';
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: string;
  } | null;
  readonly company: {
    readonly id: string;
    readonly name: string;
  } | null;
}

export interface LoginResult {
  readonly identity: AuthenticatedIdentity;
  readonly session: IssuedSession;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Verifies credentials and issues a session.
   *
   * Two behaviours matter more than the happy path:
   *
   * 1. ONE generic failure. An unknown email and a wrong password produce the
   *    identical response. Distinguishing them turns the endpoint into an
   *    account-enumeration tool: an attacker learns which addresses are
   *    registered before trying a single password against them.
   *
   * 2. Constant work. bcrypt runs even when no user matched, against a dummy
   *    hash held by PasswordService. Without it, an unknown email would return
   *    in microseconds and a known one in ~100ms, and the timing alone would
   *    give the attacker the same list the error message would have.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        passwordHash: true,
        company: { select: { id: true, name: true } },
      },
    });

    const matched = await this.passwords.verifyWithTimingFloor(
      password,
      user?.passwordHash ?? null,
    );

    if (!user || !matched) {
      throw new UnauthorizedException({
        error: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      });
    }

    const session = await this.sessions.issue(user.id);

    return {
      session,
      identity: {
        callerType: 'user',
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
        },
        // Null for the platform admin, who belongs to no company.
        company: user.company,
      },
    };
  }

  async logout(principal: UserPrincipal): Promise<void> {
    await this.sessions.revoke(principal.sessionId);
  }

  /**
   * Describes the caller back to itself.
   *
   * The response is discriminated by caller type, so one endpoint serves both
   * a company backend verifying which tenant its key resolves to and a browser
   * reading the signed-in user.
   *
   * It is built from the PRINCIPAL, never from the request, and the select
   * lists only safe columns - `passwordHash` is not among them, so there is no
   * path by which it could be serialised into a response (test F02-T28).
   */
  async describe(principal: Principal): Promise<AuthenticatedIdentity> {
    if (principal.kind === 'api-key') {
      const company = await this.prisma.company.findUniqueOrThrow({
        where: { id: principal.companyId },
        select: { id: true, name: true },
      });

      return { callerType: 'api-key', user: null, company };
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        company: { select: { id: true, name: true } },
      },
    });

    return {
      callerType: 'user',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      company: user.company,
    };
  }
}
