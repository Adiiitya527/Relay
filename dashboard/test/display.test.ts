import { describe, expect, it } from 'vitest';
import {
  attemptOutcome,
  deadByEndpoint,
  markReplays,
  canReplay,
  checkEndpointUrlInput,
  circuitBadge,
  parseEventTypes,
  statusBadge,
} from '../src/lib/display.js';
import { DELIVERY_STATUSES } from '../src/lib/types.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('circuitBadge', () => {
  it('closed and healthy', () => {
    expect(circuitBadge({ circuit_state: 'closed', circuit_open_until: null, consecutive_failures: 0 }, NOW)).toMatchObject({
      tone: 'good',
      label: 'closed',
    });
  });
  it('closed but failing warns with the count', () => {
    expect(circuitBadge({ circuit_state: 'closed', circuit_open_until: null, consecutive_failures: 3 }, NOW)).toMatchObject({
      tone: 'warn',
      label: 'closed · 3 failing',
    });
  });
  it('open shows when the probe is allowed', () => {
    expect(circuitBadge({ circuit_state: 'open', circuit_open_until: iso(25_000), consecutive_failures: 5 }, NOW).label).toBe(
      'open · probe in 25 s',
    );
    expect(circuitBadge({ circuit_state: 'open', circuit_open_until: iso(-1000), consecutive_failures: 5 }, NOW).label).toBe(
      'open · probe due',
    );
  });
  it('half-open is probing', () => {
    expect(circuitBadge({ circuit_state: 'half_open', circuit_open_until: iso(30_000), consecutive_failures: 5 }, NOW)).toMatchObject({
      tone: 'warn',
      label: 'half-open · probing',
    });
  });
});

describe('parseEventTypes', () => {
  it('empty means all event types', () => {
    expect(parseEventTypes('  ')).toEqual({ ok: true, types: [] });
  });
  it('splits on commas, spaces and newlines, trims and de-duplicates in order', () => {
    expect(parseEventTypes('order.created, invoice.paid\norder.created  user:deleted')).toEqual({
      ok: true,
      types: ['order.created', 'invoice.paid', 'user:deleted'],
    });
  });
  it.each(['.starts-with-dot', 'has/slash', 'x'.repeat(101), 'ümlaut'])('rejects %j like the API does', (bad) => {
    const result = parseEventTypes(`ok.type, ${bad}`);
    expect(result.ok).toBe(false);
  });
  it('rejects more than 100 types', () => {
    const many = Array.from({ length: 101 }, (_, i) => `t${i}`).join(',');
    expect(parseEventTypes(many)).toEqual({ ok: false, message: 'At most 100 event types' });
  });
});

describe('checkEndpointUrlInput', () => {
  it('accepts absolute http(s) URLs, trimmed', () => {
    expect(checkEndpointUrlInput('  https://example.com/hook ')).toEqual({ ok: true, url: 'https://example.com/hook' });
    expect(checkEndpointUrlInput('http://127.0.0.1:4000/hooks/a').ok).toBe(true); // the API decides
  });
  it.each(['', 'example.com/hook', 'ftp://example.com', 'javascript:alert(1)'])('rejects %j', (input) => {
    expect(checkEndpointUrlInput(input).ok).toBe(false);
  });
});

describe('deliveries', () => {
  it('every status has a badge', () => {
    for (const s of DELIVERY_STATUSES) expect(statusBadge(s).label).toBeTruthy();
    expect(statusBadge('dead').tone).toBe('bad');
  });
  it('only finished deliveries can be replayed (the API answers 409 otherwise)', () => {
    expect(DELIVERY_STATUSES.filter(canReplay)).toEqual(['succeeded', 'dead']);
  });
});

describe('attemptOutcome', () => {
  it.each([
    [{ error_kind: null, response_status: 200 }, '200', 'good'],
    [{ error_kind: 'http_status', response_status: 503 }, 'HTTP 503', 'bad'],
    [{ error_kind: 'http_status', response_status: null }, 'invalid status', 'bad'],
    [{ error_kind: 'timeout', response_status: null }, 'timeout', 'bad'],
    [{ error_kind: 'lease_expired', response_status: null }, 'lease expired', 'warn'],
    [{ error_kind: 'ssrf_blocked', response_status: null }, 'blocked (SSRF)', 'bad'],
    [{ error_kind: 'connection', response_status: null }, 'connection error', 'bad'],
    [{ error_kind: 'something_new', response_status: null }, 'something new', 'bad'],
  ])('%o → %s', (attempt, label, tone) => {
    expect(attemptOutcome(attempt)).toMatchObject({ label, tone });
  });
});

describe('markReplays', () => {
  it('marks the attempt after each replay (attempt_number restarts)', () => {
    const marked = markReplays([1, 2, 3, 1, 1, 2].map((attempt_number) => ({ attempt_number })));
    expect(marked.map((a) => a.afterReplay)).toEqual([false, false, false, true, true, false]);
  });
  it('an empty timeline stays empty', () => {
    expect(markReplays([])).toEqual([]);
  });
});

describe('deadByEndpoint', () => {
  it('counts only dead rows per endpoint, most first', () => {
    const rows = [
      { endpoint_id: 'b', status: 'dead' as const },
      { endpoint_id: 'a', status: 'dead' as const },
      { endpoint_id: 'b', status: 'dead' as const },
      { endpoint_id: 'c', status: 'pending' as const },
    ];
    expect(deadByEndpoint(rows)).toEqual([
      { endpointId: 'b', shown: 2 },
      { endpointId: 'a', shown: 1 },
    ]);
  });
});
