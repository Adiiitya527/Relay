import { relativeTime } from './format.js';
import type { Attempt, DeliveryStatus, Endpoint } from './types.js';

// Pure "what to show" decisions, kept out of the components so they can be unit-tested.

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
export interface BadgeSpec {
  tone: Tone;
  label: string;
  title: string;
}

/** Circuit breaker state as an operator reads it. */
export function circuitBadge(e: Pick<Endpoint, 'circuit_state' | 'circuit_open_until' | 'consecutive_failures'>, now: number): BadgeSpec {
  switch (e.circuit_state) {
    case 'closed':
      return e.consecutive_failures > 0
        ? { tone: 'warn', label: `closed · ${e.consecutive_failures} failing`, title: `${e.consecutive_failures} consecutive failures; opens at the threshold` }
        : { tone: 'good', label: 'closed', title: 'Healthy: deliveries flow normally' };
    case 'open': {
      const until = e.circuit_open_until;
      const due = !until || new Date(until).getTime() <= now;
      return {
        tone: 'bad',
        label: due ? 'open · probe due' : `open · probe ${relativeTime(until, now)}`,
        title: 'Deliveries are held (no attempts spent) until a single probe succeeds',
      };
    }
    case 'half_open':
      return { tone: 'warn', label: 'half-open · probing', title: 'One probe delivery is in flight; its result closes or re-opens the circuit' };
  }
}

const EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/; // same rule as server/src/events/event-type.ts
const MAX_EVENT_TYPES = 100;

/**
 * The "event types" field: comma / whitespace separated, trimmed, de-duplicated (order
 * kept). Empty = subscribed to every event type, like the API.
 */
export function parseEventTypes(input: string): { ok: true; types: string[] } | { ok: false; message: string } {
  const types = [...new Set(input.split(/[\s,]+/).filter(Boolean))];
  const bad = types.find((t) => !EVENT_TYPE.test(t));
  if (bad !== undefined) {
    return { ok: false, message: `"${bad.slice(0, 40)}" is not a valid event type (letters, digits, . _ : -)` };
  }
  if (types.length > MAX_EVENT_TYPES) return { ok: false, message: `At most ${MAX_EVENT_TYPES} event types` };
  return { ok: true, types };
}

/** Quick client-side check of the URL field; the API applies the real rules (https, SSRF). */
export function checkEndpointUrlInput(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const url = input.trim();
  if (!url) return { ok: false, message: 'Enter the endpoint URL.' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, message: 'The URL must start with https://' };
  } catch {
    return { ok: false, message: 'That is not a valid absolute URL.' };
  }
  return { ok: true, url };
}

export function statusBadge(status: DeliveryStatus): BadgeSpec {
  switch (status) {
    case 'pending':
      return { tone: 'info', label: 'pending', title: 'Waiting for its next attempt' };
    case 'in_flight':
      return { tone: 'warn', label: 'in flight', title: 'A worker is sending it now' };
    case 'succeeded':
      return { tone: 'good', label: 'succeeded', title: 'The endpoint answered 2xx' };
    case 'dead':
      return { tone: 'bad', label: 'dead', title: 'All attempts failed; replay it after fixing the endpoint' };
  }
}

/** Only finished deliveries can be replayed (the API answers 409 otherwise). */
export function canReplay(status: DeliveryStatus): boolean {
  return status === 'dead' || status === 'succeeded';
}

/** One attempt in a few words: "200", "HTTP 503", "timeout", "lease expired". */
export function attemptOutcome(a: Pick<Attempt, 'error_kind' | 'response_status'>): BadgeSpec {
  if (a.error_kind === null) {
    return { tone: 'good', label: a.response_status === null ? 'ok' : String(a.response_status), title: 'Delivered' };
  }
  switch (a.error_kind) {
    case 'http_status':
      return {
        tone: 'bad',
        label: a.response_status === null ? 'invalid status' : `HTTP ${a.response_status}`,
        title: 'The endpoint answered with a non-2xx status (redirects are not followed)',
      };
    case 'timeout':
      return { tone: 'bad', label: 'timeout', title: 'No complete answer within HTTP_TIMEOUT_MS' };
    case 'lease_expired':
      return { tone: 'warn', label: 'lease expired', title: 'The worker stopped before recording a result; recovered by the sweeper' };
    case 'ssrf_blocked':
      return { tone: 'bad', label: 'blocked (SSRF)', title: 'The URL resolves to a private or reserved address' };
    case 'dns':
      return { tone: 'bad', label: 'DNS error', title: 'The hostname did not resolve' };
    case 'connection':
      return { tone: 'bad', label: 'connection error', title: 'Connection refused or reset' };
    case 'tls':
      return { tone: 'bad', label: 'TLS error', title: 'The certificate could not be verified' };
    default:
      return { tone: 'bad', label: a.error_kind.replace(/_/g, ' '), title: 'Delivery failed' };
  }
}
