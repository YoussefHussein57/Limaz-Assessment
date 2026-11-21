/**
 * The provider's delivery route, written down once.
 *
 * Deliberately a literal rather than an import from the controller: these
 * tests assert the PUBLISHED contract, and a path that moved because somebody
 * changed a decorator should break them loudly rather than follow along.
 */
export const WEBHOOK_PATH = '/v1/webhooks/card-transactions';
