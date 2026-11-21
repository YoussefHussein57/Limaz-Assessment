import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import {
  cardEventEnvelopeSchema,
  settledTransactionSchema,
  SUPPORTED_EVENT_TYPE,
  type SettledTransaction,
} from './dto/card-event.dto';
import { computeSignature, signaturesMatch } from './webhook-crypto';
import { WebhookIntegrationService } from './webhook-integration.service';

/** The three headers the provider sends. Lowercase: Node lowercases them. */
export const WEBHOOK_ID_HEADER = 'x-limaz-webhook-id';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-limaz-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-limaz-signature';

export type IntakeOutcome = 'ACCEPTED' | 'DUPLICATE' | 'IGNORED';

export interface IntakeResult {
  readonly eventId: string;
  readonly status: IntakeOutcome;
  readonly message: string;
}

export interface IntakeHeaders {
  readonly [key: string]: string | string[] | undefined;
}

/**
 * Authenticating a card webhook and accepting it durably (F12).
 *
 * =============================================================================
 * THE THREE TIMESTAMPS, WHICH ARE NOT THE SAME THING
 * =============================================================================
 *
 * Conflating them is the classic webhook bug, so they are named apart here and
 * in the README:
 *
 *   SIGNATURE timestamp  `x-limaz-timestamp`. When this HTTP REQUEST was
 *                        signed. Bounded by WEBHOOK_TOLERANCE_SECONDS, which
 *                        is replay protection and nothing else.
 *
 *   TRANSACTION time     `data.spentAt`. When the money was spent. Bounded by
 *                        the expense rules (A4: 90 days back, 5 minutes
 *                        forward) and used for the frequency window.
 *
 *   PROCESSING time      when a worker evaluated it. Recorded, never used to
 *                        decide anything.
 *
 * A payment from last Tuesday, re-delivered this morning because the provider
 * was down, is LEGITIMATE: an old transaction time with a fresh signature
 * timestamp. Rejecting it because `spentAt` is old would drop real expenses.
 * Accepting a week-old SIGNATURE would make a captured request replayable for
 * a week. The two bounds protect different things and have different sizes.
 *
 * =============================================================================
 * WHICH COMPANY THIS BELONGS TO
 * =============================================================================
 *
 * The assessment is explicit: work out which company each webhook belongs to
 * WITHOUT TRUSTING THE PAYLOAD, and the provider cannot send our API key.
 *
 * So the request carries a delivery id in a header. That id is UNTRUSTED
 * LOOKUP INPUT - it selects which secret to verify against, and nothing else.
 * The company is taken from the integration row whose secret actually
 * verified the signature. An attacker who names another company's delivery id
 * is checked against that company's secret, which they do not hold.
 *
 * The body is never consulted for tenancy. There is no company field in the
 * event schema at all, so there is no field to ignore.
 */
@Injectable()
export class WebhookIntakeService {
  private readonly logger = new Logger(WebhookIntakeService.name);

  private readonly toleranceSeconds: number;

  /**
   * A key nobody holds, used to do real HMAC work when the delivery id
   * matched nothing.
   *
   * Without it, an unknown delivery id returns after one indexed SELECT while
   * a known one additionally decrypts and computes an HMAC - and the
   * difference says which delivery ids exist. The same reasoning as
   * `PasswordService.dummyHash`, applied to the other credential.
   */
  private readonly dummySecret = 'whsec_not-a-real-signing-secret-for-timing-only';

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: WebhookIntegrationService,
    @Inject(ENV) env: Env,
  ) {
    this.toleranceSeconds = env.WEBHOOK_TOLERANCE_SECONDS;
  }

  /**
   * Verifies one delivery and, if it is genuine, stores it.
   *
   * `rawBody` is the bytes as received. See `signedPayload` for why nothing
   * that has been parsed and re-serialised may be used here.
   */
  async accept(headers: IntakeHeaders, rawBody: Buffer | undefined): Promise<IntakeResult> {
    if (!rawBody) {
      // No bytes means nothing was signed, so there is nothing to verify.
      // Checked here rather than only inside `authenticate` so the rest of
      // this method works with a definite Buffer - the parsing below must use
      // the SAME bytes the signature covered, and an optional type invites a
      // future reader to fall back to the parsed body instead.
      throw unauthenticated();
    }

    const companyId = await this.authenticate(headers, rawBody);

    // Only now is anything parsed. An unauthenticated body is never examined
    // beyond its length: parsing attacker-controlled JSON before deciding
    // whether the sender is genuine is work done on behalf of anybody who can
    // reach the port.
    const envelope = this.parseEnvelope(rawBody);

    if (envelope.type !== SUPPORTED_EVENT_TYPE) {
      return this.recordIgnored(companyId, envelope.id, envelope.type);
    }

    const parsed = settledTransactionSchema.safeParse(envelope.data);

    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        message: parsed.error.issues
          .map((issue) => {
            const field = ['data', ...issue.path.map(String)].join('.');
            return `${field}: ${issue.message}`;
          })
          .join('; '),
      });
    }

    return this.record(companyId, envelope.id, envelope.type, parsed.data);
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Returns the company whose secret verified this request, or throws 401.
   *
   * ONE error shape for every cause: missing header, malformed timestamp,
   * expired timestamp, unknown delivery id, malformed signature, wrong
   * signature. Telling them apart tells an attacker which guess was closer -
   * the same rule the login endpoint follows.
   */
  private async authenticate(
    headers: IntakeHeaders,
    rawBody: Buffer,
  ): Promise<string> {
    const deliveryId = readHeader(headers, WEBHOOK_ID_HEADER);
    const timestamp = readHeader(headers, WEBHOOK_TIMESTAMP_HEADER);
    const signature = readHeader(headers, WEBHOOK_SIGNATURE_HEADER);

    if (!deliveryId || !timestamp || !signature) {
      throw unauthenticated();
    }

    if (!this.timestampIsFresh(timestamp)) {
      throw unauthenticated();
    }

    const resolved = await this.integrations.resolveSecret(deliveryId);

    // The HMAC runs either way. See `dummySecret`.
    const secret = resolved?.signingSecret ?? this.dummySecret;
    const expected = computeSignature(secret, timestamp, rawBody);
    const matched = signaturesMatch(expected, signature);

    if (!resolved || !matched) {
      throw unauthenticated();
    }

    return resolved.companyId;
  }

  /**
   * Whether the signature timestamp is inside the tolerance, on both sides.
   *
   * The FUTURE bound is not symmetry for its own sake. Without it, a captured
   * request signed with a timestamp years ahead would stay replayable until
   * that date arrives - the past bound alone does nothing about a clock set
   * forward.
   *
   * Seconds, as an integer. `parseInt` is not used: it accepts `1763000000abc`
   * and silently returns a number, so a malformed header would pass.
   */
  private timestampIsFresh(value: string): boolean {
    if (!/^\d{1,15}$/u.test(value)) {
      return false;
    }

    const seconds = Number(value);
    const skew = Math.abs(Date.now() / 1_000 - seconds);

    return Number.isFinite(skew) && skew <= this.toleranceSeconds;
  }

  // ---------------------------------------------------------------------------
  // Durable acceptance
  // ---------------------------------------------------------------------------

  private parseEnvelope(rawBody: Buffer) {
    let json: unknown;

    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException({
        error: 'invalid_request',
        message: 'The request body is not valid JSON.',
      });
    }

    const parsed = cardEventEnvelopeSchema.safeParse(json);

    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        message: parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      });
    }

    return parsed.data;
  }

  /**
   * Stores a supported event, or recognises a redelivery of one.
   *
   * ---------------------------------------------------------------------
   * THE RESPONSE IS SENT AFTER THE COMMIT, NEVER BEFORE
   * ---------------------------------------------------------------------
   *
   * The provider retries until it gets a 2xx, so a 2xx is a promise that this
   * event will be processed. Answering before the row is committed would
   * break that promise on the first restart: the provider stops retrying, and
   * the event exists nowhere.
   *
   * That is also why the expense is NOT created here. Doing the policy
   * evaluation inline would make acceptance depend on how long an evaluation
   * takes, and a provider that times out retries - which is how one payment
   * becomes several attempts at one expense. Accept fast, process after.
   */
  private async record(
    companyId: string,
    providerEventId: string,
    eventType: string,
    data: SettledTransaction,
  ): Promise<IntakeResult> {
    const payloadHash = payloadHashOf(eventType, data);

    try {
      const created = await this.prisma.webhookEvent.create({
        data: {
          companyId,
          providerEventId,
          eventType,
          payloadHash,
          payload: data as unknown as Prisma.InputJsonObject,
        },
        select: { id: true },
      });

      return {
        eventId: created.id,
        status: 'ACCEPTED',
        message: 'Accepted for processing.',
      };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }

      // The UNIQUE on (companyId, providerEventId) is the authority. A
      // check-then-insert would let two simultaneous deliveries of the same
      // event both pass the check (F12-T20).
      return this.resolveRedelivery(companyId, providerEventId, payloadHash);
    }
  }

  /**
   * Decides what a second delivery of the same event id means.
   *
   * Identical payload - a retry. The provider is doing exactly what it
   * promised, and the honest answer is 2xx with nothing new created. Anything
   * else makes it retry forever.
   *
   * Different payload - NOT a retry. The same event id now describes a
   * different payment. That is a provider bug, a replay with a modified body
   * that somehow carried a valid signature, or an identifier reused by
   * mistake. This service cannot tell which, and all three deserve a refusal
   * rather than a silent overwrite of a decision already issued (the same
   * reasoning as ADR-001 for expenses).
   */
  private async resolveRedelivery(
    companyId: string,
    providerEventId: string,
    payloadHash: string,
  ): Promise<IntakeResult> {
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { companyId_providerEventId: { companyId, providerEventId } },
      select: { id: true, payloadHash: true },
    });

    if (!existing) {
      // The unique constraint fired and the row is gone. Events are never
      // deleted by this service, so this is a genuine internal inconsistency
      // and must not be reported as success.
      this.logger.error(
        `Unique violation on ${companyId}/${providerEventId}, but no row was found afterwards.`,
      );
      throw new ConflictException({
        error: 'conflict',
        message: 'This event could not be stored. Retry.',
      });
    }

    if (existing.payloadHash !== payloadHash) {
      throw new ConflictException({
        error: 'event_payload_conflict',
        message: `Event '${providerEventId}' was already received with a different payload.`,
        details: { conflictingField: 'id', eventId: existing.id },
      });
    }

    return {
      eventId: existing.id,
      status: 'DUPLICATE',
      message: 'Already received. Nothing further was created.',
    };
  }

  /**
   * An authenticated event this system does not process.
   *
   * Stored and answered 2xx rather than refused, because the provider retries
   * until it gets one. A `transaction.reversed` we have no handler for would
   * otherwise be redelivered forever, and the retry traffic would look like
   * an outage.
   *
   * The row is kept so an administrator can see that something arrived and
   * was deliberately not acted on - the difference between "we ignore this"
   * and "it never got here".
   */
  private async recordIgnored(
    companyId: string,
    providerEventId: string,
    eventType: string,
  ): Promise<IntakeResult> {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(['ignored', eventType]), 'utf8')
      .digest('hex');

    try {
      const created = await this.prisma.webhookEvent.create({
        data: {
          companyId,
          providerEventId,
          eventType,
          payloadHash,
          payload: {},
          status: 'IGNORED',
          processedAt: new Date(),
          lastError: `Event type '${eventType}' is not processed by this service.`,
        },
        select: { id: true },
      });

      return {
        eventId: created.id,
        status: 'IGNORED',
        message: `Accepted. Event type '${eventType}' is not processed by this service.`,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.resolveRedelivery(companyId, providerEventId, payloadHash);
      }

      throw error;
    }
  }
}

/**
 * The identity of an event's BUSINESS content.
 *
 * A fixed-order array for the same reason `canonical-payload.ts` uses one: key
 * ordering stops being a question when order is part of the structure.
 *
 * It deliberately excludes `createdAt`, the signature timestamp and the
 * signature. A legitimate replay of the same event is signed afresh, so those
 * change while the payment does not - folding them in would make every retry
 * look like a conflicting event and the provider could never successfully
 * redeliver anything.
 */
export function payloadHashOf(eventType: string, data: SettledTransaction): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        eventType,
        data.transactionId,
        data.cardholderId,
        data.amount,
        data.currency,
        data.merchant,
        data.category,
        new Date(data.spentAt).toISOString(),
      ]),
      'utf8',
    )
    .digest('hex');
}

function unauthenticated(): UnauthorizedException {
  return new UnauthorizedException({
    error: 'webhook_signature_invalid',
    message: 'The signature, the timestamp or the webhook id was not accepted.',
  });
}

/**
 * Reads one header, refusing a repeated one.
 *
 * A duplicated signature header is not a legitimate shape, and "whichever the
 * parser happened to prefer" is not a decision worth making silently - the
 * same rule `AuthenticationGuard` applies to cookies and API keys.
 */
function readHeader(headers: IntakeHeaders, name: string): string | null {
  const value = headers[name];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}
