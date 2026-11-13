import { describe, expect, it } from 'vitest';
import { generateEndpointSecret } from '../../src/endpoints/secret.js';
import { checkEndpointUrl, endpointUrlSchema } from '../../src/endpoints/url.js';
import { eventTypeSchema } from '../../src/events/event-type.js';

describe('checkEndpointUrl', () => {
  it('accepts https and returns the normalised form', () => {
    expect(checkEndpointUrl('HTTPS://Example.COM:443/hook?x=1', false)).toEqual({
      ok: true,
      url: 'https://example.com/hook?x=1',
    });
  });

  it('rejects http by default, accepts it when allowed', () => {
    expect(checkEndpointUrl('http://example.com/h', false)).toEqual({
      ok: false,
      reason: 'scheme must be https',
    });
    expect(checkEndpointUrl('http://example.com/h', true)).toEqual({
      ok: true,
      url: 'http://example.com/h',
    });
  });

  it.each(['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x'])(
    'rejects non-http(s) scheme %j even when http is allowed',
    (url) => expect(checkEndpointUrl(url, true).ok).toBe(false),
  );

  it.each(['https://user:pass@example.com/', 'https://user@example.com/', 'https://:pw@example.com/'])(
    'rejects credentials in %j',
    (url) =>
      expect(checkEndpointUrl(url, false)).toEqual({
        ok: false,
        reason: 'must not contain credentials (user:pass@)',
      }),
  );

  it.each(['', 'example.com/hook', '/relative', 'https://', 'not a url'])('rejects non-absolute %j', (url) =>
    expect(checkEndpointUrl(url, false)).toEqual({ ok: false, reason: 'must be an absolute URL' }),
  );

  it('enforces 2048 chars on the stored (normalised) form', () => {
    const base = 'https://example.com/';
    expect(checkEndpointUrl(base + 'a'.repeat(2048 - base.length), false).ok).toBe(true);
    expect(checkEndpointUrl(base + 'a'.repeat(2049 - base.length), false).ok).toBe(false);
    // Normalisation can GROW a URL: a space inside the path becomes %20 (1 → 3 chars).
    // (Spaces at the very end would be trimmed by the parser instead, hence the trailing 'b'.)
    const grows = base + 'a'.repeat(2040 - base.length) + ' '.repeat(5) + 'b';
    expect(grows.length).toBeLessThanOrEqual(2048);
    expect(checkEndpointUrl(grows, false).ok).toBe(false);
  });

  it('the Zod schema reports the reason as an issue', () => {
    const r = endpointUrlSchema(false).safeParse('http://example.com');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('scheme must be https');
  });
});

describe('generateEndpointSecret', () => {
  it('is whsec_ + standard base64 of 24 random bytes', () => {
    const secret = generateEndpointSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(secret.slice('whsec_'.length), 'base64')).toHaveLength(24);
  });

  it('is different every time', () => {
    expect(new Set(Array.from({ length: 1000 }, generateEndpointSecret)).size).toBe(1000);
  });
});

describe('eventTypeSchema', () => {
  it.each(['invoice.paid', 'user:created', 'a', 'A-1_b.c:d', 'x'.repeat(100)])('accepts %j', (t) =>
    expect(eventTypeSchema.safeParse(t).success).toBe(true),
  );
  it.each(['', '.paid', '-x', 'has space', 'émoji', 'x'.repeat(101), 'a/b'])('rejects %j', (t) =>
    expect(eventTypeSchema.safeParse(t).success).toBe(false),
  );
});
