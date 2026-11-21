import { SetMetadata } from '@nestjs/common';

export const IS_WEBHOOK_EXEMPT = 'limaz:webhook-exempt';

/**
 * Exempts a route from `CsrfGuard` because it carries no ambient credential.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NARROW, AND WHY IT IS NOT A WAY AROUND CSRF
 * ---------------------------------------------------------------------------
 *
 * CSRF is a browser problem. It exists because a cookie is attached
 * AUTOMATICALLY to every request to its origin, including a request a hostile
 * page caused - the attacker never reads the credential, they only make the
 * browser send it.
 *
 * `CsrfGuard` already exempts API-key callers for exactly this reason: a
 * company backend sends its key deliberately, from code, with no browser and
 * no ambient credential. This decorator says the same thing about a route
 * that authenticates with an HMAC signature it computes per request.
 *
 * A cross-site page that makes a browser POST to such a route achieves
 * nothing: the browser has no signing secret, so the request is refused by
 * the signature check it cannot pass. The `x-limaz-client` header CsrfGuard
 * would otherwise require is also a header no payment provider has a reason
 * to send, so requiring it would break the integration while protecting
 * nothing.
 *
 * It must NEVER be placed on a route that reads the session cookie. There is
 * exactly one route carrying it - the card webhook endpoint - and a test
 * asserts that count, so adding a second one is a deliberate act somebody has
 * to defend (F12-T06).
 */
export const WebhookExempt = () => SetMetadata(IS_WEBHOOK_EXEMPT, true);
