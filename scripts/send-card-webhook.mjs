#!/usr/bin/env node
/**
 * Delivers a signed card webhook WITHOUT the simulator.
 *
 * =============================================================================
 * WHY THIS EXISTS WHEN THERE IS ALREADY A SIMULATOR IN THE UI
 * =============================================================================
 *
 * The simulator is a demonstration tool that happens to run inside the API
 * process. That is convenient, and it is also the one thing that could make a
 * passing demonstration meaningless: if the only client that ever signs a
 * request is the server itself, a mistake in the signing contract would be
 * symmetric and invisible - the signer and the verifier would agree with each
 * other and disagree with every real provider.
 *
 * This script is an INDEPENDENT implementation. It reads the documented
 * contract, computes the HMAC with Node's standard library, and sends the
 * bytes over the network. If the README is wrong about the contract, this
 * fails.
 *
 * =============================================================================
 * THE SIGNING SECRET IS NOT IN THIS FILE
 * =============================================================================
 *
 * It comes from the environment, and the repository contains none. A secret
 * committed for convenience is a secret in the clone history forever.
 *
 *   WEBHOOK_DELIVERY_ID   the company's delivery id (public, from the UI)
 *   WEBHOOK_SECRET        the signing secret, shown once when provisioned
 *   WEBHOOK_URL           optional, defaults to the local stack
 *
 * Usage:
 *
 *   WEBHOOK_DELIVERY_ID=whi_... WEBHOOK_SECRET=whsec_... \
 *     node scripts/send-card-webhook.mjs --amount 95000 --merchant "City Taxi"
 *
 *   # replay the same event: pass the id it printed
 *   ... node scripts/send-card-webhook.mjs --event-id evt_abc123
 *
 *   # prove the verifier is real
 *   ... node scripts/send-card-webhook.mjs --tamper
 */

import { createHmac, randomBytes } from 'node:crypto';

const DEFAULT_URL = 'http://127.0.0.1:3001/v1/webhooks/card-transactions';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);

  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const flag = (name) => process.argv.includes(`--${name}`);

const deliveryId = process.env.WEBHOOK_DELIVERY_ID;
const secret = process.env.WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL ?? DEFAULT_URL;

if (!deliveryId || !secret) {
  process.stderr.write(
    'Set WEBHOOK_DELIVERY_ID and WEBHOOK_SECRET.\n' +
      'Both come from provisioning the integration on the company page in the admin workspace.\n',
  );
  process.exit(1);
}

const eventId = argument('event-id', `evt_${randomBytes(6).toString('hex')}`);
const transactionId = argument('transaction-id', `txn_${randomBytes(4).toString('hex')}`);

// The provider's shape, exactly as the assessment specifies it.
const event = {
  id: eventId,
  type: argument('type', 'transaction.settled'),
  createdAt: new Date().toISOString(),
  data: {
    transactionId,
    cardholderId: argument('employee', 'emp-7'),
    amount: Number(argument('amount', '12500')),
    currency: argument('currency', 'SAR'),
    merchant: argument('merchant', 'City Taxi'),
    category: argument('category', 'TRANSPORT'),
    spentAt: argument('spent-at', new Date().toISOString()),
  },
};

/*
 * SERIALISE ONCE, SIGN AND SEND THE SAME BYTES.
 *
 * This is the whole discipline. `JSON.stringify` called twice can produce two
 * different strings if anything in between touches the object, and the HMAC
 * covers bytes rather than meaning. Signing one string and sending another is
 * the single most common way a webhook integration fails, and it fails
 * intermittently, which is worse.
 */
const rawBody = Buffer.from(JSON.stringify(event), 'utf8');

const timestamp = flag('expired')
  ? String(Math.floor(Date.now() / 1000) - 3600) // an hour old: outside tolerance
  : String(Math.floor(Date.now() / 1000));

// `${timestamp}.${rawBody}` - the timestamp is INSIDE the signed material, so
// it cannot be changed without invalidating the signature. A signature that
// covered only the body would let anybody replay a captured request forever
// by moving the timestamp forward.
const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');

// `--tamper` changes the BODY after signing. Everything else stays valid, so
// a 2xx here would mean the verifier is not actually checking the body.
const bodyToSend = flag('tamper')
  ? Buffer.from(JSON.stringify({ ...event, data: { ...event.data, amount: 1 } }), 'utf8')
  : rawBody;

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-limaz-webhook-id': deliveryId,
    'x-limaz-timestamp': timestamp,
    'x-limaz-signature': flag('bad-signature') ? 'f'.repeat(64) : signature,
  },
  body: bodyToSend,
});

const text = await response.text();

/*
 * The exact command that REDELIVERS this event.
 *
 * It is printed rather than left to the reader because the obvious attempt -
 * re-running with `--event-id` alone - does not work, and fails in a way that
 * looks like a bug in the server. Payload identity covers every business
 * field including `spentAt`, which defaults to "now", so a minute later the
 * same event id describes a different payment and the endpoint correctly
 * answers 409 `event_payload_conflict`.
 *
 * A replay has to repeat every field. This is that command.
 */
const expectedToFail = flag('tamper') || flag('expired') || flag('bad-signature');

const replayCommand = [
  'node scripts/send-card-webhook.mjs',
  `--event-id ${event.id}`,
  `--transaction-id ${transactionId}`,
  `--employee ${event.data.cardholderId}`,
  `--amount ${event.data.amount}`,
  `--currency ${event.data.currency}`,
  `--merchant ${JSON.stringify(event.data.merchant)}`,
  `--category ${event.data.category}`,
  `--spent-at ${event.data.spentAt}`,
].join(' ');

// The secret is never printed, and neither is the signature header's value
// beyond its first characters - enough to tell two runs apart, not enough to
// replay one from a terminal recording.
process.stdout.write(
  [
    `POST ${url}`,
    `  event          ${event.id}`,
    `  transaction    ${transactionId}`,
    `  amount         ${event.data.amount} ${event.data.currency} (minor units)`,
    `  signature      ${signature.slice(0, 12)}... (${signature.length} hex chars)`,
    flag('tamper') ? '  tampered       body changed AFTER signing' : '',
    flag('expired') ? '  timestamp      one hour old, outside tolerance' : '',
    flag('bad-signature') ? '  signature      deliberately wrong' : '',
    '',
    `HTTP ${response.status}`,
    `  ${text}`,
    '',
    ...(response.status === 202 && !expectedToFail
      ? ['Redeliver exactly this event (a fresh signature, the same payment):', `  ${replayCommand}`, '']
      : []),
  ]
    .filter(Boolean)
    .join('\n'),
);

// A deliberate-failure run is a SUCCESS for this script: the verifier refused
// what it was supposed to refuse.
process.exit(expectedToFail ? (response.status === 401 ? 0 : 1) : response.ok ? 0 : 1);
