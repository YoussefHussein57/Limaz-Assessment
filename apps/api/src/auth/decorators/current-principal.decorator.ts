import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import { PRINCIPAL, type AuthenticatedRequest, type Principal } from '../principal.types';

/**
 * Injects the authenticated principal into a handler.
 *
 * This is the ONLY way a handler learns who is calling. There is deliberately
 * no decorator that reads a company id from the body, a query parameter or a
 * header, because such a thing would be the vulnerability this whole feature
 * exists to prevent.
 *
 * It throws rather than returning undefined on a route that was never
 * authenticated: a handler holding `undefined` where it expects a principal
 * would most likely go on to query with no tenant filter at all.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL];

    if (!principal) {
      throw new Error(
        'CurrentPrincipal used on a route with no authenticated principal. ' +
          'A @Public() route has no caller identity by definition.',
      );
    }

    return principal;
  },
);
