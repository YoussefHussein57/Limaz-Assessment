import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { API_KEY_HEADER } from '../api-key.service';

/** Required on every state-changing request that is not API-key authenticated. */
export const CSRF_HEADER = 'x-limaz-client';

/** Methods that must never change state, so they need no CSRF protection. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery protection for cookie-authenticated callers.
 *
 * THE PROBLEM
 * A cookie is attached by the browser to every request to its origin,
 * including requests a different site caused. HttpOnly does nothing about
 * that: the attacker never needs to read the cookie, only to make the browser
 * send it.
 *
 * WHY THIS APPLIES TO LOGIN, WHICH HAS NO SESSION YET
 * Login CSRF: a hostile page POSTs the ATTACKER's credentials to our login
 * endpoint, and the victim ends up signed in to the attacker's account without
 * noticing. Everything they then do lands in the attacker's account. So the
 * rule is not "requests with a session"; it is "requests that are not API-key
 * authenticated", which covers login and logout alike.
 *
 * WHY API KEY CALLERS ARE EXEMPT
 * CSRF needs a browser that attaches a credential automatically. A company
 * backend sends its key deliberately, from code, with no ambient credential
 * and no browser. Applying browser rules to it would break server-to-server
 * integration while protecting nothing.
 *
 * THE TWO CHECKS
 *
 * 1. A custom header must be present.
 *    A cross-origin <form> cannot set headers at all. A cross-origin fetch()
 *    that sets one is no longer a "simple request", so the browser must send a
 *    CORS preflight first - and we return no CORS headers, so the browser
 *    cancels before the real request is ever sent. This is why the API
 *    deliberately has no CORS configuration: adding one would only ever OPEN
 *    access that is currently closed by default.
 *
 * 2. If an Origin header is present, it must match APP_ORIGIN.
 *    Origin is a forbidden header name - page JavaScript cannot forge it, the
 *    browser sets it - so when present it is trustworthy. The check is "if
 *    present, must match" rather than "must be present", because non-browser
 *    clients do not send one and requiring it would break them. This moves the
 *    judgement from the browser's CORS implementation to our own server, so it
 *    still holds if a browser is misconfigured or buggy.
 *
 * WHAT THIS DOES NOT STOP
 * XSS. Script injected into our own page runs same-origin: it can set the
 * custom header, it sends a correct Origin, and the browser attaches the
 * cookie. It still cannot READ the cookie, but it does not need to. CSRF
 * defence and XSS defence are different problems; the latter needs CSP and
 * output escaping, and is recorded as a limitation.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly appOrigin: string;

  constructor(@Inject(ENV) env: Env) {
    this.appOrigin = env.APP_ORIGIN;
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<IncomingMessage>();
    const method = (request.method ?? 'GET').toUpperCase();

    if (SAFE_METHODS.has(method)) {
      return true;
    }

    // Presence of the header is enough to exempt: whether the key is VALID is
    // AuthenticationGuard's business. An invalid key is already a 401, so a
    // caller cannot skip CSRF by sending a fake key and still get through.
    const presentsApiKey = typeof request.headers[API_KEY_HEADER] === 'string';
    if (presentsApiKey) {
      return true;
    }

    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && origin !== this.appOrigin) {
      throw new ForbiddenException({
        error: 'cross_origin_rejected',
        message: 'This request did not come from the application origin.',
      });
    }

    if (typeof request.headers[CSRF_HEADER] !== 'string') {
      throw new ForbiddenException({
        error: 'csrf_header_required',
        message: `State-changing browser requests must send the ${CSRF_HEADER} header.`,
      });
    }

    return true;
  }
}
