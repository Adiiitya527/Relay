import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { errorMessage, formatDuration, relativeTime, shortId } from '../src/lib/format.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('relativeTime', () => {
  it.each([
    [0, 'now'],
    [-400, 'now'],
    [-12_000, '12 s ago'],
    [30_000, 'in 30 s'],
    [-5 * 60_000, '5 min ago'],
    [2 * 3_600_000, 'in 2 h'],
    [-3 * 86_400_000, '3 d ago'],
  ])('%i ms → %s', (offset, text) => {
    expect(relativeTime(at(offset), NOW)).toBe(text);
  });

  it('an unparsable timestamp renders as a dash', () => {
    expect(relativeTime('not a date', NOW)).toBe('—');
  });
});

describe('formatDuration', () => {
  it.each<[number | null, string]>([
    [null, '—'],
    [0, '0 ms'],
    [999, '999 ms'],
    [1234, '1.23 s'],
    [12_345, '12.3 s'],
  ])('%s → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('errorMessage', () => {
  it('includes the API error code, but not for network or proxy errors', () => {
    expect(errorMessage(new ApiError(409, 'delivery_not_replayable', 'Delivery is pending'))).toBe(
      'Delivery is pending (delivery_not_replayable)',
    );
    expect(errorMessage(new ApiError(0, 'network_error', 'Cannot reach the Relay API. Is it running?'))).toBe(
      'Cannot reach the Relay API. Is it running?',
    );
    expect(errorMessage(new ApiError(502, 'http_error', 'HTTP 502 (the API may be down)'))).toBe('HTTP 502 (the API may be down)');
  });
  it('handles plain errors and unknown values', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('weird')).toBe('Something went wrong');
  });
});

it('shortId keeps the first 8 characters', () => {
  expect(shortId('6f1c1a8e-1111-4222-8333-444455556666')).toBe('6f1c1a8e');
});
