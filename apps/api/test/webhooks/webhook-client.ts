import type { INestApplication } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import request from 'supertest';
import { WEBHOOK_PATH } from './webhook-path';

export const WEBHOOK_ID_HEADER = 'x-limaz-webhook-id';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-limaz-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-limaz-signature';

export interface SettledEventInput {
  readonly id?: string;
  readonly type?: string;
  readonly transactionId?: string;
  readonly cardholderId?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly merchant?: string;
  readonly category?: string;
  readonly spentAt?: string;
}

/**
 * Builds a provider event in the shape the assessment specifies.
 *
 * Deterministic where the test needs it and random where it does not, so a
 * case that cares about identity says so by passing one.
 */
export function cardEvent(input: SettledEventInput = {}): Record<string, unknown> {
  return {
    id: input.id ?? `evt_${randomBytes(6).toString('hex')}`,
    type: input.type ?? 'transaction.settled',
    createdAt: new Date().toISOString(),
    data: {
      transactionId: input.transactionId ?? `txn_${randomBytes(5).toString('hex')}`,
      // UNIQUE per event unless a test names one.
      //
      // A shared default looked harmless and was not: by the tenth case,
      // 'emp-7' had enough expenses in the window that the FREQUENCY rule
      // fired on events that were testing something else entirely, and the
      // failures read as policy-engine bugs (AI_LOG 59). A test that cares
      // about an employee's history now has to say so.
      cardholderId: input.cardholderId ?? `emp-${randomBytes(4).toString('hex')}`,
      amount: input.amount ?? 12_500,
      currency: input.currency ?? 'SAR',
      merchant: input.merchant ?? 'City Taxi',
      category: input.category ?? 'TRANSPORT',
      // A minute ago: inside the A4 submission window, and in the past, so
      // nothing depends on how long the test takes to run.
      spentAt: input.spentAt ?? new Date(Date.now() - 60_000).toISOString(),
    },
  };
}

/**
 * An INDEPENDENT implementation of the signing contract.
 *
 * It computes the HMAC itself rather than importing `computeSignature` from
 * the source. That matters: if both sides of these tests came from the same
 * function, a mistake in it would be symmetric and invisible - the tests
 * would agree with the implementation and both would disagree with a real
 * provider. This is the second implementation that makes the first one
 * checkable, the same role `scripts/send-card-webhook.mjs` plays by hand.
 */
export function sign(secret: string, timestamp: string, rawBody: Buffer): string {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);

  return createHmac('sha256', secret).update(signed).digest('hex');
}

export interface DeliveryOverrides {
  /** Replaces the computed signature. */
  readonly signature?: string;
  /** Replaces the timestamp used for BOTH signing and the header. */
  readonly timestamp?: string;
  /** Sent in the header but NOT used to sign - the stale-timestamp case. */
  readonly headerTimestamp?: string;
  readonly deliveryId?: string;
  /** Sent instead of the signed bytes - the tampered-body case. */
  readonly bodyOverride?: string;
  readonly omit?: ReadonlyArray<'id' | 'timestamp' | 'signature'>;
}

/**
 * Delivers one event over supertest.
 *
 * The body is serialised ONCE and the same bytes are signed and sent, unless
 * a test deliberately asks for otherwise. Serialising twice is the classic
 * way an integration becomes intermittently broken.
 */
export function deliver(
  app: INestApplication,
  deliveryId: string,
  secret: string,
  event: unknown,
  overrides: DeliveryOverrides = {},
): request.Test {
  // A STRING, serialised once, and the same string is signed and sent.
  //
  // It was a Buffer at first, and that was wrong in a way worth recording:
  // with `content-type: application/json`, supertest re-serialises a Buffer
  // into `{"type":"Buffer","data":[123,34,...]}`, so the bytes on the wire
  // were not the bytes that had been signed. Every valid-signature case
  // failed with 401 while every refusal case passed - a failure pattern that
  // looks exactly like a broken verifier and was a broken test client
  // (AI_LOG 57).
  const serialised = JSON.stringify(event);
  const rawBody = Buffer.from(serialised, 'utf8');
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1_000));
  const signature = overrides.signature ?? sign(secret, timestamp, rawBody);
  const omit = new Set(overrides.omit ?? []);

  const test = request(app.getHttpServer())
    .post(WEBHOOK_PATH)
    .set('content-type', 'application/json');

  if (!omit.has('id')) {
    test.set(WEBHOOK_ID_HEADER, overrides.deliveryId ?? deliveryId);
  }

  if (!omit.has('timestamp')) {
    test.set(WEBHOOK_TIMESTAMP_HEADER, overrides.headerTimestamp ?? timestamp);
  }

  if (!omit.has('signature')) {
    test.set(WEBHOOK_SIGNATURE_HEADER, signature);
  }

  // A string goes out verbatim. `.send(object)` would serialise a second
  // time and `.send(Buffer)` re-encodes - see the note above.
  return test.send(overrides.bodyOverride ?? serialised);
}
