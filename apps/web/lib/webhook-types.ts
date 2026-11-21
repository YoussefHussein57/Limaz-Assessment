/** The shapes the card webhook and simulator endpoints return (F12). */

export type WebhookEventStatus = 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'IGNORED';

export interface WebhookIntegrationConfigured {
  configured: true;
  /** Public. It selects which signing secret to verify against; it proves nothing. */
  deliveryId: string;
  secretVersion: number;
  createdAt: string;
  rotatedAt: string | null;
}

export type WebhookIntegrationState = WebhookIntegrationConfigured | { configured: false };

/**
 * A freshly provisioned integration.
 *
 * The only shape in this application besides an issued API key that carries a
 * plaintext secret. It is held in one piece of component state, shown once,
 * and dropped - never in a query cache, browser storage, a URL or a log.
 */
export interface ProvisionedWebhookIntegration {
  integration: WebhookIntegrationConfigured;
  signingSecret: string;
}

export interface WebhookEventSummary {
  id: string;
  companyId: string;
  companyName: string;
  providerEventId: string;
  eventType: string;
  status: WebhookEventStatus;
  attempts: number;
  receivedAt: string;
  nextAttemptAt: string | null;
  processedAt: string | null;
  expenseId: string | null;
  /** The automated policy decision, once an expense exists. */
  decision: 'APPROVE' | 'REVIEW' | 'REJECT' | null;
  expenseStatus: 'APPROVED' | 'REJECTED' | 'PENDING_REVIEW' | null;
  /** Sanitised where it was written. Never a stack trace. */
  lastError: string | null;
}

export interface WebhookEventPage {
  items: WebhookEventSummary[];
  nextCursor: string | null;
}

export type SimulationMode = 'VALID' | 'INVALID_SIGNATURE' | 'EXPIRED_SIGNATURE';

export interface SimulatePaymentInput {
  companyId: string;
  mode: SimulationMode;
  eventType?: string;
  /**
   * Redeliver a stored event VERBATIM.
   *
   * Not the same as passing its id: the payload identity covers every
   * business field including spentAt, so rebuilding from the form a minute
   * later is a DIFFERENT payment with the same id - a conflict, not a
   * replay. The server reads the stored payload back instead.
   */
  replayOf?: string;

  /** Reuse this event id while CHANGING the payment - the conflict case. */
  eventId?: string;
  transactionId?: string;
  cardholderId: string;
  /** Minor units. Converted from the typed decimal string, never via a float. */
  amount: number;
  merchant: string;
  category: string;
  spentAt?: string;
}

export interface SimulationResult {
  providerEventId: string;
  requestBody: unknown;
  delivery: {
    status: number;
    body: unknown;
  };
  /** Null when the endpoint refused the delivery - there is no event to poll. */
  eventId: string | null;
  mode: SimulationMode;
}

export interface SimulatorState {
  enabled: boolean;
  endpoint: string;
}
