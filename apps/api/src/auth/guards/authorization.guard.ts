import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import type { IncomingMessage } from 'node:http';
import { ALLOWED_CALLER_TYPES } from '../decorators/caller-types.decorator';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { REQUIRED_ROLES } from '../decorators/roles.decorator';
import {
  PRINCIPAL,
  type AuthenticatedRequest,
  type CallerType,
} from '../principal.types';

/**
 * Decides WHAT an already-identified caller may do.
 *
 * Authentication and authorization are separate questions, and answering the
 * first does not answer the second: a genuine API key proves a company is
 * calling, and proves nothing about whether a company may resolve a review.
 *
 * Everything here answers with 403, never 404. 403 means "this exists and you
 * may not" - fine at the role layer, because the existence of admin routes is
 * not a secret. At the ROW layer it would be an enumeration oracle, which is
 * why a row outside the caller's tenant answers 404 instead (ADR-003). The two
 * rejections live in different places on purpose.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<IncomingMessage & AuthenticatedRequest>();
    const principal = request[PRINCIPAL];

    if (!principal) {
      // AuthenticationGuard runs first and throws when it cannot resolve one,
      // so this is unreachable in the wired application. Failing closed here
      // means a future reordering of the guards degrades to "denied" rather
      // than to "allowed".
      throw new ForbiddenException({ error: 'forbidden', message: 'Access denied.' });
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, targets);
    const allowedCallerTypes = this.reflector.getAllAndOverride<CallerType[]>(
      ALLOWED_CALLER_TYPES,
      targets,
    );

    // @Roles() implies a human caller: an API key has no role, so a key can
    // never satisfy a role requirement however valid it is.
    const effectiveCallerTypes: CallerType[] | undefined =
      requiredRoles && requiredRoles.length > 0 ? ['user'] : allowedCallerTypes;

    if (effectiveCallerTypes && !effectiveCallerTypes.includes(principal.kind)) {
      throw new ForbiddenException({
        error: 'caller_type_not_allowed',
        message: 'This endpoint is not available to this kind of caller.',
      });
    }

    if (requiredRoles && requiredRoles.length > 0) {
      if (principal.kind !== 'user' || !requiredRoles.includes(principal.role)) {
        throw new ForbiddenException({
          error: 'insufficient_role',
          message: 'Your role does not permit this action.',
        });
      }
    }

    return true;
  }
}
