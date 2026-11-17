import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '../../src/delivery/backoff.js';

const opts = { baseMs: 2_000, capMs: 600_000 }; // the defaults from config.ts
const noJitter = () => 0.5; // factor 0.8 + 0.4 * 0.5 = 1.0 exactly

describe('computeBackoffMs', () => {
  it('doubles from the base for each attempt (no jitter)', () => {
    const schedule = [1, 2, 3, 4, 5, 6, 7, 8].map((a) => computeBackoffMs(a, opts, noJitter));
    expect(schedule).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000]);
  });

  it('stops growing at the cap', () => {
    // 2 s * 2^9 = 1024 s > 600 s cap
    expect(computeBackoffMs(10, opts, noJitter)).toBe(600_000);
    expect(computeBackoffMs(11, opts, noJitter)).toBe(600_000);
  });

  it('applies ±20 % jitter: lower bound at random() = 0', () => {
    expect(computeBackoffMs(1, opts, () => 0)).toBe(1_600);
  });

  it('applies ±20 % jitter: just under the upper bound as random() → 1', () => {
    const delay = computeBackoffMs(1, opts, () => 0.999_999);
    expect(delay).toBeGreaterThan(2_399);
    expect(delay).toBeLessThanOrEqual(2_400);
  });

  it('jitters on top of the cap, so the longest delay is 1.2 * cap (D50)', () => {
    expect(computeBackoffMs(50, opts, () => 0)).toBe(480_000);
    expect(computeBackoffMs(50, opts, () => 0.999_999)).toBeLessThanOrEqual(720_000);
    expect(computeBackoffMs(50, opts, () => 0.999_999)).toBeGreaterThan(600_000);
  });

  it('returns whole milliseconds', () => {
    expect(Number.isInteger(computeBackoffMs(3, { baseMs: 7, capMs: 1_000 }, () => 0.123))).toBe(
      true,
    );
  });

  it('does not overflow for huge attempt numbers', () => {
    expect(computeBackoffMs(100, opts, noJitter)).toBe(600_000);
    expect(computeBackoffMs(10_000, opts, noJitter)).toBe(600_000); // 2 ** 9999 = Infinity
  });

  it('stays within bounds with the real Math.random', () => {
    for (let i = 0; i < 1_000; i++) {
      const delay = computeBackoffMs(2, opts);
      expect(delay).toBeGreaterThanOrEqual(3_200);
      expect(delay).toBeLessThanOrEqual(4_800);
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects attempt %s', (attempt) => {
    expect(() => computeBackoffMs(attempt, opts)).toThrow(RangeError);
  });

  it('rejects a cap below the base', () => {
    expect(() => computeBackoffMs(1, { baseMs: 10, capMs: 5 })).toThrow(RangeError);
  });
});
