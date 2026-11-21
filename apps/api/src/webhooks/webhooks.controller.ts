import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { Public } from '../auth/decorators';
import { WebhookExempt } from '../auth/decorators/webhook-exempt.decorator';
import { WebhookIntakeService, type IntakeResult } from './webhook-intake.service';

/**
 * The card provider's delivery endpoint (F12 - assessment section 10).
 *
 * =============================================================================
 * WHY THIS ROUTE IS @Public() AND @WebhookExempt(), AND WHY THAT IS NOT A HOLE
 * =============================================================================
 *
 * `@Public()` turns off `AuthenticationGuard`. The provider cannot send our
 * API key - the assessment says so explicitly - and it has no session. It
 * authenticates with an HMAC signature instead, which the guard knows nothing
 * about. So the route is public to the GUARD and authenticated by
 * `WebhookIntakeService`, which refuses with 401 before the body is parsed.
 *
 * `@WebhookExempt()` turns off `CsrfGuard`, and the reasoning is the one that
 * also exempts API-key callers. CSRF protects credentials a BROWSER attaches
 * automatically: a cookie travels on any request to its origin, including one
 * a hostile page caused. This route reads no cookie and no ambient
 * credential. A cross-site page that makes a browser POST here achieves
 * nothing, because the browser cannot produce a signature it does not have
 * the key for - and the `x-limaz-client` header CsrfGuard would otherwise
 * demand is a header a payment provider has no reason to send.
 *
 * Both decorators are on the method, where the next person to read this route
 * will see them.
 *
 * =============================================================================
 * 202, NOT 201
 * =============================================================================
 *
 * The event is stored; no expense exists yet. 201 would say "created" about
 * something that has not been decided, and a provider dashboard showing
 * "created" for an event that will be REJECTED by policy is a lie told by a
 * status code.
 *
 * 202 is a 2xx, which is what the provider needs to stop retrying, and it
 * says exactly what happened: accepted for processing. The response body
 * repeats it in words, because "accepted" and "approved" are one letter apart
 * and mean opposite things here.
 */
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly intake: WebhookIntakeService) {}

  @Post('card-transactions')
  @Public()
  @WebhookExempt()
  @HttpCode(HttpStatus.ACCEPTED)
  // Nothing here is cacheable and the body names an internal event id. A POST
  // response is already uncacheable by default; this is for the intermediaries
  // that are not.
  @Header('Cache-Control', 'no-store')
  async receive(@Req() request: RawBodyRequest<IncomingMessage>): Promise<IntakeResult> {
    // `request.rawBody` is the bytes as received, kept by Nest because
    // `rawBody: true` is set in main.ts. The parsed body is deliberately NOT
    // used for verification - see `signedPayload` in webhook-crypto.ts.
    return this.intake.accept(request.headers, request.rawBody);
  }
}
