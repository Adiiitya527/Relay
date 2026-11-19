import { describe, expect, it } from 'vitest';
import { apiProxyTarget, DEFAULT_API_URL, PROXIED_PATHS } from '../dev-proxy.js';

describe('apiProxyTarget', () => {
  it('defaults to the local API', () => {
    expect(apiProxyTarget(undefined)).toBe(DEFAULT_API_URL);
    expect(apiProxyTarget('  ')).toBe(DEFAULT_API_URL);
  });

  it('accepts an http(s) origin, with or without a trailing slash', () => {
    expect(apiProxyTarget('http://api:3000')).toBe('http://api:3000');
    expect(apiProxyTarget('https://relay.example.com/')).toBe('https://relay.example.com');
  });

  it.each([
    ['not a url', 'localhost:3000'],
    ['wrong scheme', 'ftp://host'],
    ['a path', 'http://host:3000/v1'],
    ['a query', 'http://host:3000/?x=1'],
  ])('rejects %s', (_name, value) => {
    expect(() => apiProxyTarget(value)).toThrow(/DASHBOARD_API_URL/);
  });

  it('proxies the API, health and metrics paths', () => {
    expect(PROXIED_PATHS).toEqual(['/v1', '/healthz', '/metrics']);
  });
});
