import { apiGet, apiSend, queryString } from './api-client';
import type {
  ProvisionedWebhookIntegration,
  SimulatePaymentInput,
  SimulationResult,
  SimulatorState,
  WebhookEventPage,
  WebhookEventStatus,
  WebhookEventSummary,
  WebhookIntegrationState,
} from './webhook-types';

/**
 * Keys and fetchers for card webhook intake (F12).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 * No query key holds a signing secret, and none ever will. Provisioning is a
 * MUTATION and its plaintext lives in component state for as long as the
 * dialog showing it is open - the same rule the API key secret follows, for
 * the same reasons: a cache survives navigation, is collected on its own
 * schedule, and is walked by devtools and error reporters.
 */

export const webhookKeys = {
  all: ['webhooks'] as const,
  integration: (companyId: string) => [...webhookKeys.all, 'integration', companyId] as const,
  simulator: () => [...webhookKeys.all, 'simulator'] as const,
  events: () => [...webhookKeys.all, 'events'] as const,
  eventList: (companyId: string, status: string, cursor: string | null) =>
    [...webhookKeys.events(), 'list', companyId, status, cursor] as const,
  event: (eventId: string) => [...webhookKeys.events(), 'detail', eventId] as const,
};

export const EVENT_PAGE_SIZE = 25;

export async function fetchWebhookIntegration(
  companyId: string,
  signal?: AbortSignal,
): Promise<WebhookIntegrationState> {
  return apiGet<WebhookIntegrationState>(
    `/v1/admin/companies/${encodeURIComponent(companyId)}/webhook-integration`,
    signal,
  );
}

/**
 * Creates the integration, or replaces its signing secret.
 *
 * The response carries the plaintext secret ONCE. Its caller must put it in
 * local state and nowhere else.
 */
export async function provisionWebhookIntegration(
  companyId: string,
): Promise<ProvisionedWebhookIntegration> {
  return apiSend<ProvisionedWebhookIntegration>(
    'POST',
    `/v1/admin/companies/${encodeURIComponent(companyId)}/webhook-integration`,
    {},
  );
}

export async function fetchSimulatorState(signal?: AbortSignal): Promise<SimulatorState> {
  return apiGet<SimulatorState>('/v1/admin/simulator', signal);
}

/**
 * Delivers one synthetic signed event to the real webhook endpoint.
 *
 * NOT retried. A retry would deliver a second request, and whether that is a
 * duplicate or a new event depends on whether the server generated the id -
 * which the client cannot know after a failed response.
 */
export async function simulatePayment(input: SimulatePaymentInput): Promise<SimulationResult> {
  return apiSend<SimulationResult>('POST', '/v1/admin/simulator/payments', input);
}

export async function fetchWebhookEvents(
  companyId: string,
  status: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<WebhookEventPage> {
  const query = queryString({
    companyId: companyId || undefined,
    status: status || undefined,
    cursor: cursor ?? undefined,
    limit: EVENT_PAGE_SIZE,
  });

  return apiGet<WebhookEventPage>(`/v1/admin/webhook-events${query}`, signal);
}

export async function fetchWebhookEvent(
  eventId: string,
  signal?: AbortSignal,
): Promise<WebhookEventSummary> {
  return apiGet<WebhookEventSummary>(
    `/v1/admin/webhook-events/${encodeURIComponent(eventId)}`,
    signal,
  );
}

/**
 * Whether an event can still change.
 *
 * The polling interval is derived from THIS, not from a timer that counts
 * down and then declares success. A progress bar that advances on its own
 * would be a fabricated animation of work that may not be happening.
 */
export function isTerminal(status: WebhookEventStatus): boolean {
  return status === 'PROCESSED' || status === 'FAILED' || status === 'IGNORED';
}
