import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { type AuthenticatedIdentity, AuthService } from './auth.service';
import { AllowCallerTypes, CurrentPrincipal, Public } from './decorators';
import { loginSchema } from './dto/login.dto';
import type { Principal, UserPrincipal } from './principal.types';
import { SessionService } from './session.service';

/**
 * Three endpoints. No fourth.
 *
 * Every public surface is something that has to be defended in review, so the
 * API gained exactly what the feature needs: a way in, a way to ask who you
 * are, and a way out. The guards and the tenant helper are exercised by tests
 * through a probe controller that exists only inside the test module, so
 * proving them costs no production surface at all.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Public, because a caller cannot already be authenticated here - but NOT
   * unguarded: CsrfGuard still demands the custom header and a matching
   * Origin, which is what stops login CSRF (a hostile page signing a victim
   * into the attacker's account).
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<AuthenticatedIdentity> {
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      // Shape errors only. Never "no such user" or "password too short" -
      // either would confirm whether the address exists.
      throw new BadRequestException({
        error: 'invalid_request',
        message: 'email and password are required.',
      });
    }

    const { identity, session } = await this.auth.login(parsed.data.email, parsed.data.password);

    response.setHeader(
      'set-cookie',
      this.sessions.buildSetCookie(session.token, this.sessions.ttlSeconds),
    );

    return identity;
  }

  /**
   * Accepts both caller types and answers in a discriminated shape.
   *
   * For a company backend this confirms which tenant its key resolves to -
   * genuinely useful during integration, and it reveals nothing the caller did
   * not already hold the credential for.
   */
  @Get('me')
  async me(@CurrentPrincipal() principal: Principal): Promise<AuthenticatedIdentity> {
    return this.auth.describe(principal);
  }

  /**
   * Users only: an API key has no session to end.
   *
   * Revocation happens in the database. Clearing the cookie is client-side
   * tidying, and the client is assumed to be able to ignore it - which is
   * exactly why a stateless JWT cannot do this.
   */
  @AllowCallerTypes('user')
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<void> {
    await this.auth.logout(principal as UserPrincipal);
    response.setHeader('set-cookie', this.sessions.buildClearCookie());
  }
}
