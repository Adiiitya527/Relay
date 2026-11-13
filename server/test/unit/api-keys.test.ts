import { describe, expect, it } from 'vitest';
import { applicationNameSchema } from '../../src/applications/repo.js';
import { API_KEY_PREFIX, generateApiKey, hashApiKey, looksLikeApiKey } from '../../src/auth/api-keys.js';

describe('generateApiKey', () => {
  it('produces rly_ + 43 base64url characters', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^rly_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(47);
  });

  it('carries 32 random bytes (256 bits) after the prefix', () => {
    const body = generateApiKey().slice(API_KEY_PREFIX.length);
    expect(Buffer.from(body, 'base64url')).toHaveLength(32);
  });

  it('never repeats across many generations', () => {
    const keys = new Set(Array.from({ length: 10_000 }, generateApiKey));
    expect(keys.size).toBe(10_000);
  });
});

describe('hashApiKey', () => {
  it('is SHA-256 of the full key (known test vector)', () => {
    // NIST test vector: SHA-256("abc")
    expect(hashApiKey('abc').toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns 32 bytes, deterministic, and differs per key', () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toHaveLength(32);
    expect(hashApiKey(key).equals(hashApiKey(key))).toBe(true);
    expect(hashApiKey(key).equals(hashApiKey(generateApiKey()))).toBe(false);
  });
});

describe('looksLikeApiKey', () => {
  it('accepts a generated key', () => {
    expect(looksLikeApiKey(generateApiKey())).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['wrong prefix', 'sk_' + 'a'.repeat(43)],
    ['too short', 'rly_' + 'a'.repeat(42)],
    ['too long', 'rly_' + 'a'.repeat(44)],
    ['standard base64 chars', 'rly_' + '+'.repeat(43)],
    ['trailing whitespace', generateApiKey() + ' '],
  ])('rejects %s', (_label, value) => {
    expect(looksLikeApiKey(value)).toBe(false);
  });
});

describe('applicationNameSchema', () => {
  it('trims surrounding whitespace', () => {
    expect(applicationNameSchema.parse('  demo  ')).toBe('demo');
  });

  it.each(['', '   ', 'x'.repeat(201)])('rejects %j', (name) => {
    expect(applicationNameSchema.safeParse(name).success).toBe(false);
  });
});
