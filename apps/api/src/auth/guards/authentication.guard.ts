import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import { API_KEY_HEADER, ApiKeyService } from '../api-key.service';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { PRINCIPAL, type AuthenticatedRequest } from '../principal.types';
import { SESSION_COOKIE_NAME, SessionService } from '../session.service';

/**
 * Resolves WHO is calling. Says nothing about what they may do - that is
 * AuthorizationGuard.
 *
 * Registered globally, so every route is protected the moment it exists and
 * opening one requires writing @Public() on it.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<IncomingMessage & AuthenticatedRequest>();

    const apiKey = readHeader(request, API_KEY_HEADER);
    const cookieToken = readCookie(request, SESSION_COOKIE_NAME);

    // Two credential kinds in one request is not a legitimate shape. Silently
    // preferring one would make the caller's intent ambiguous, and ambiguity
    // between "acting as a company" and "acting as a person" is exactly the
    // confusion this feature exists to prevent. Rejected before either is
    // validated, so nothing is leaked about whether either was real.
    if (apiKey && cookieToken) {
      throw new BadRequestException({
        error: 'ambiguous_credentials',
        message: 'Present either an API key or a session cookie, not both.',
      });
    }

    if (isPublic) {
      return true;
    }

    const principal = apiKey
      ? await this.apiKeys.resolve(apiKey)
      : cookieToken
        ? await this.sessions.resolve(cookieToken)
        : null;

    if (!principal) {
      // One shape for every cause: no credential, unknown key, revoked key,
      // expired key, forged cookie, revoked session, expired session. Telling
      // them apart tells an attacker which guess was closer.
      throw new UnauthorizedException({
        error: 'unauthenticated',
        message: 'Valid credentials are required.',
      });
    }

    request[PRINCIPAL] = principal;
    return true;
  }
}

function readHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // A repeated header arrives as an array. Two different API keys in one
  // request is as ambiguous as mixing credential kinds, so refuse rather than
  // picking one.
  return null;
}

/**
 * Reads one cookie from the Cookie header.
 *
 * Hand-written rather than pulling in cookie-parser: we need exactly one
 * cookie by an exact name, and a dependency whose only job is a `split(';')`
 * is a dependency somebody will have to justify (risk R-13).
 *
 * Returns null if the name appears more than once, rather than taking the
 * first or last. A duplicated session cookie is how cookie-shadowing attacks
 * work, and "whichever the parser happened to prefer" is not a decision worth
 * making silently.
 */
function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;

  if (typeof header !== 'string' || header.length === 0) {
    return null;
  }

  const matches: string[] = [];

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator).trim() === name) {
      matches.push(part.slice(separator + 1).trim());
    }
  }

  if (matches.length !== 1) {
    return null;
  }

  const value = matches[0]!;
  return value.length > 0 ? value : null;
}
