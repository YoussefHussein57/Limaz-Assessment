export type ComponentStatus = 'up' | 'down';

export interface DatabaseCheck {
  readonly status: ComponentStatus;
  /** Round-trip time of a `SELECT 1`, in milliseconds. Present only when up. */
  readonly latencyMs?: number;
  /** Deliberately generic. Driver errors can embed the connection string. */
  readonly error?: string;
}

export interface HealthResult {
  readonly status: 'ok' | 'degraded';
  readonly uptimeSeconds: number;
  readonly checks: {
    readonly database: DatabaseCheck;
  };
}
