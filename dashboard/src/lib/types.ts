// Response shapes of the Relay API (server/src/**/repo.ts, query.ts). Timestamps arrive as
// ISO strings in JSON. Lease internals (lease_token, locked_until, locked_by) are never sent.

export type CircuitState = 'closed' | 'open' | 'half_open';
export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'dead';
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['pending', 'in_flight', 'succeeded', 'dead'];

export interface Endpoint {
  id: string;
  url: string;
  description: string;
  event_types: string[];
  disabled: boolean;
  circuit_state: CircuitState;
  circuit_open_until: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

/** Only the create response carries the secret. */
export interface CreatedEndpoint extends Endpoint {
  secret: string;
}

export interface MessageSummary {
  id: string;
  event_type: string;
  idempotency_key: string | null;
  created_at: string;
}

export interface MessageDelivery {
  id: string;
  endpoint_id: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MessageDetail extends MessageSummary {
  payload: Record<string, unknown>;
  deliveries: MessageDelivery[];
}

export interface Delivery extends MessageDelivery {
  message_id: string;
  event_type: string;
}

export interface Attempt {
  id: string;
  attempt_number: number;
  worker_id: string;
  recorded_at: string;
  duration_ms: number | null;
  response_status: number | null;
  response_excerpt: string | null;
  error_kind: string | null;
  error_message: string | null;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Published {
  message: MessageSummary;
  deliveries: { id: string; endpoint_id: string; status: DeliveryStatus }[];
}
