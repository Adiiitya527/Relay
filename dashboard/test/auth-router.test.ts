import { describe, expect, it } from 'vitest';
import { createKeyStore, normalizeApiKey, STORAGE_KEY } from '../src/lib/auth.js';
import { formatHash, parseHash, type Route } from '../src/lib/router.js';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('key store', () => {
  it('stores, reads and clears the key under one name', () => {
    const storage = memoryStorage();
    const store = createKeyStore(storage);
    expect(store.get()).toBeNull();
    store.set('key_abc');
    expect(storage.map.get(STORAGE_KEY)).toBe('key_abc');
    expect(store.get()).toBe('key_abc');
    store.clear();
    expect(store.get()).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('falls back to memory when storage throws (privacy mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const store = createKeyStore(throwing);
    store.set('key_mem');
    expect(store.get()).toBe('key_mem');
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('works without any storage', () => {
    const store = createKeyStore(undefined);
    store.set('k');
    expect(store.get()).toBe('k');
  });
});

describe('normalizeApiKey', () => {
  it('trims and strips a pasted "Bearer " prefix', () => {
    expect(normalizeApiKey('  Bearer key_123\n')).toEqual({ ok: true, key: 'key_123' });
  });
  it.each([[''], ['   '], ['two words'], ['x'.repeat(201)]])('rejects %j', (input) => {
    expect(normalizeApiKey(input).ok).toBe(false);
  });
});

describe('hash router', () => {
  const ID = '6f1c1a8e-1111-4222-8333-444455556666';

  it.each<[string, Route]>([
    ['', { name: 'endpoints' }],
    ['#/', { name: 'endpoints' }],
    ['#/endpoints', { name: 'endpoints' }],
    ['#/messages', { name: 'messages' }],
    [`#/messages/${ID}`, { name: 'message', id: ID }],
    ['#/deliveries', { name: 'deliveries' }],
    [`#/deliveries?status=dead&endpoint=${ID}`, { name: 'deliveries', status: 'dead', endpointId: ID }],
    [`#/deliveries/${ID.toUpperCase()}`, { name: 'delivery', id: ID }],
  ])('parses %j', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it.each(['#/nope', '#/messages/123', '#/deliveries/not-a-uuid', `#/messages/${ID}/extra`, '#/endpoints/x'])(
    '%j is not found',
    (hash) => {
      expect(parseHash(hash)).toEqual({ name: 'not_found' });
    },
  );

  it('ignores invalid filter values instead of passing them to the API', () => {
    expect(parseHash('#/deliveries?status=exploded&endpoint=../../x')).toEqual({ name: 'deliveries' });
  });

  it('format → parse round-trips every route', () => {
    const routes: Route[] = [
      { name: 'endpoints' },
      { name: 'messages' },
      { name: 'message', id: ID },
      { name: 'deliveries' },
      { name: 'deliveries', status: 'pending' },
      { name: 'deliveries', status: 'dead', endpointId: ID },
      { name: 'delivery', id: ID },
    ];
    for (const route of routes) expect(parseHash(formatHash(route))).toEqual(route);
  });
});
