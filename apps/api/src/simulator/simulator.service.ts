import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../webhooks/webhook-intake.service';
import { computeSignature } from '../webhooks/webhook-crypto';
import { WebhookIntegrationService } from '../webhooks/webhook-integration.service';
import type { SimulatePaymentDto } from './dto/simulator.dto';

/** The route the simulator always posts to. Never caller-supplied. */
const WEBHOOK_PATH = '/v1/webhooks/card-transactions';

export interface SimulationResult {
  /** The provider event id that was generated or replayed. */
  readonly providerEventId: string;
  /** The body that was signed and sent, so the demonstration is inspectable. */
  readonly requestBody: unknown;
  /** What the real webhook endpoint answered. */
  readonly delivery: {
    readonly status: number;
    readonly body: unknown;
  };
  /** Present only when the endpoint accepted it. */
  readonly eventId: string | null;
  /** Which signature the simulator produced. Never the secret. */
  readonly mode: SimulatePaymentDto['mode'];
}

/**
 * The sandbox payment simulator (F12).
 *
 * =============================================================================
 * WHAT THIS IS, AND THE ONE THING IT MUST NOT BE
 * =============================================================================
 *
 * It is a stand-in for the card provider, so that the whole webhook pipeline
 * can be demonstrated without a real provider, a real card, or a single
 * riyal moving. No card number, expiry or CVV is asked for anywhere - the
 * provider's contract does not contain one, so neither does this.
 *
 * What it must not be is a shortcut. It does NOT call
 * `ExpenseSubmissionService`, it does not create a `WebhookEvent`, and it does
 * not compute an expected decision in the browser and display it. It builds a
 * real request body, signs it with the company's real signing secret, and
 * sends it over HTTP to the real endpoint - which verifies the signature it
 * would verify for anybody. If signature verification broke, every preset
 * here would start failing, which is exactly the property a demonstration
 * tool should have.
 *
 * =============================================================================
 * WHY THERE IS NO DESTINATION PARAMETER
 * =============================================================================
 *
 * The destination is built from `API_PORT` and a constant path, on the
 * loopback interface. A caller-supplied URL would make this an authenticated
 * SSRF primitive: a platform administrator could aim a signed POST at a cloud
 * metadata endpoint, an internal admin panel, or any host reachable from the
 * API container. The feature gains nothing from being configurable, so it is
 * not.
 *
 * =============================================================================
 * WHY THE FLAG IS CHECKED HERE AND NOT ONLY IN THE UI
 * =============================================================================
 *
 * Hiding a navigation link is presentation. The flag is enforced in the
 * service, so a disabled sandbox refuses a direct API call too (F12-T44) -
 * the assessment's own rule that every guarantee must hold when somebody
 * skips the UI.
 */
@Injectable()
export class SimulatorService {
  private readonly logger = new Logger(SimulatorService.name);

  private readonly enabled: boolean;
  private readonly destination: string;
  private readonly toleranceSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: WebhookIntegrationService,
    @Inject(ENV) env: Env,
  ) {
    this.enabled = env.SANDBOX_SIMULATOR_ENABLED;
    this.toleranceSeconds = env.WEBHOOK_TOLERANCE_SECONDS;
    this.destination = `http://127.0.0.1:${env.API_PORT}${WEBHOOK_PATH}`;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 404, not 403: a disabled sandbox should not advertise that it exists. */
  assertEnabled(): void {
    if (!this.enabled) {
      throw new NotFoundException({
        error: 'not_found',
        message: 'The sandbox simulator is not enabled on this deployment.',
      });
    }
  }

  async simulate(input: SimulatePaymentDto): Promise<SimulationResult> {
    this.assertEnabled();

    const company = await this.prisma.company.findUnique({
      where: { id: input.companyId },
      select: { id: true, currency: true },
    });

    if (!company) {
      throw new NotFoundException({ error: 'not_found', message: 'No such company.' });
    }

    const resolved = await this.integrationFor(company.id);

    const body = input.replayOf
      ? await this.replayBody(company.id, input.replayOf)
      : {
          // The provider's own shape, exactly as the assessment specifies it.
          // Built HERE rather than taken from the browser, so the simulator
          // cannot be used to post an arbitrary body to an internal endpoint.
          id: input.eventId ?? `evt_${randomBytes(6).toString('hex')}`,
          type: input.eventType,
          createdAt: new Date().toISOString(),
          data: {
            transactionId: input.transactionId ?? `txn_${randomBytes(4).toString('hex')}`,
            cardholderId: input.cardholderId,
            amount: input.amount,
            // The company's currency, not the caller's. A simulator that could
            // send a mismatched currency would only ever demonstrate a 422.
            currency: company.currency,
            merchant: input.merchant,
            category: input.category,
            spentAt: input.spentAt ?? new Date().toISOString(),
          },
        };

    const providerEventId = body.id;

    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const { timestamp, signature } = this.signatureFor(input.mode, resolved.signingSecret, rawBody);

    const delivery = await this.deliver(resolved.deliveryId, timestamp, signature, rawBody);

    return {
      providerEventId,
      requestBody: body,
      delivery,
      eventId: readEventId(delivery.body),
      mode: input.mode,
    };
  }

  /**
   * Produces the signature the chosen preset calls for.
   *
   * The failure presets do NOT disable verification anywhere - they send a
   * genuinely wrong signature, or a genuinely stale timestamp, to the real
   * verifier. A preset that flipped a flag on the server would demonstrate
   * nothing: the thing being shown is that the verifier refuses them.
   */
  private signatureFor(
    mode: SimulatePaymentDto['mode'],
    secret: string,
    rawBody: Buffer,
  ): { timestamp: string; signature: string } {
    if (mode === 'EXPIRED_SIGNATURE') {
      // Correctly signed, with a timestamp well outside the tolerance. This
      // is the replay case: the bytes and the MAC agree, and the request is
      // refused anyway because it is old.
      const stale = String(Math.floor(Date.now() / 1_000) - this.toleranceSeconds - 60);

      return { timestamp: stale, signature: computeSignature(secret, stale, rawBody) };
    }

    const timestamp = String(Math.floor(Date.now() / 1_000));

    if (mode === 'INVALID_SIGNATURE') {
      // A well-formed signature of the right shape, computed with a key the
      // server does not hold. Not a random string: a malformed one would be
      // rejected by the shape check before the comparison, which would
      // demonstrate the wrong thing.
      const wrongSecret = `whsec_${randomBytes(32).toString('base64url')}`;

      return { timestamp, signature: computeSignature(wrongSecret, timestamp, rawBody) };
    }

    return { timestamp, signature: computeSignature(secret, timestamp, rawBody) };
  }

  /**
   * Sends the request and reports what came back.
   *
   * A delivery failure is NOT an error for this endpoint. An invalid-signature
   * preset is supposed to produce a 401, and turning that into a 500 would
   * make the demonstration unable to show the thing it exists to show.
   */
  private async deliver(
    deliveryId: string,
    timestamp: string,
    signature: string,
    rawBody: Buffer,
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;

    try {
      response = await fetch(this.destination, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_ID_HEADER]: deliveryId,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
        // Bounded, so a wedged endpoint cannot hold an administrator's
        // browser request open indefinitely.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.error(
        `Simulated delivery to ${this.destination} failed`,
        error instanceof Error ? error.message : undefined,
      );

      throw new UnprocessableEntityException({
        error: 'delivery_failed',
        message: 'The simulated request could not reach the webhook endpoint.',
      });
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      // Not every refusal has a JSON body - a 413 from the body parser does
      // not. The status is the part the panel branches on, and it is always
      // there.
      body = null;
    }

    return { status: response.status, body };
  }

  /**
   * Rebuilds the exact body of an event this company already received.
   *
   * A provider replaying an event re-sends what it sent before, so this reads
   * the stored payload rather than constructing a new one from form fields
   * that have moved on since.
   *
   * `createdAt` IS regenerated, and that is correct: it is the moment the
   * provider emitted this delivery, not a business field. It takes no part in
   * the payload identity, so the replay still hashes identically and is
   * recognised as a duplicate - which is the whole point of excluding
   * delivery metadata from that hash.
   */
  private async replayBody(
    companyId: string,
    providerEventId: string,
  ): Promise<{ id: string; type: string; createdAt: string; data: Record<string, unknown> }> {
    const stored = await this.prisma.webhookEvent.findUnique({
      where: { companyId_providerEventId: { companyId, providerEventId } },
      select: { providerEventId: true, eventType: true, payload: true },
    });

    if (!stored) {
      throw new UnprocessableEntityException({
        error: 'event_not_found',
        message: `No event '${providerEventId}' has been received for this company, so there is nothing to replay.`,
      });
    }

    return {
      id: stored.providerEventId,
      type: stored.eventType,
      createdAt: new Date().toISOString(),
      data: stored.payload as Record<string, unknown>,
    };
  }

  private async integrationFor(
    companyId: string,
  ): Promise<{ deliveryId: string; signingSecret: string }> {
    const integration = await this.prisma.webhookIntegration.findUnique({
      where: { companyId },
      select: { deliveryId: true },
    });

    if (!integration) {
      throw new UnprocessableEntityException({
        error: 'integration_not_configured',
        message: 'This company has no webhook integration yet. Provision one first.',
      });
    }

    const resolved = await this.integrations.resolveSecret(integration.deliveryId);

    if (!resolved) {
      // The row was read a moment ago. Reaching here means it was removed in
      // between, which is a real inconsistency rather than a caller error.
      throw new ForbiddenException({
        error: 'integration_not_configured',
        message: 'This company has no webhook integration.',
      });
    }

    // The SECRET stays here. It is used to sign, in this process, and is
    // never returned to the browser, put in a URL, or logged.
    return { deliveryId: integration.deliveryId, signingSecret: resolved.signingSecret };
  }
}

function readEventId(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const shaped = body as { eventId?: unknown };

    return typeof shaped.eventId === 'string' ? shaped.eventId : null;
  }

  return null;
}
