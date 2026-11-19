import { describe, expect, it } from 'vitest';
import { sanitizeText, TEXT_LIMIT, toExcerpt } from '../../src/delivery/excerpt.js';

describe('sanitizeText', () => {
  it('strips NUL characters (Postgres text cannot store U+0000)', () => {
    expect(sanitizeText('a\u0000b\u0000')).toBe('ab');
  });

  it('cuts to the limit in code points, never splitting a surrogate pair', () => {
    const emoji = '😀'; // 1 code point, 2 UTF-16 units
    const text = emoji.repeat(TEXT_LIMIT + 5);
    const out = sanitizeText(text);
    expect(Array.from(out)).toHaveLength(TEXT_LIMIT);
    expect(out).toBe(emoji.repeat(TEXT_LIMIT));
  });

  it('leaves short text unchanged', () => {
    expect(sanitizeText('HTTP 503')).toBe('HTTP 503');
  });
});

describe('toExcerpt', () => {
  it('decodes UTF-8 and keeps it within the limit', () => {
    expect(toExcerpt(Buffer.from('{"error":"nope"}'))).toBe('{"error":"nope"}');
    expect(Array.from(toExcerpt(Buffer.alloc(5_000, 'a')))).toHaveLength(TEXT_LIMIT);
  });

  it('replaces a multi-byte character cut in half by the read limit with U+FFFD', () => {
    const euro = Buffer.from('€'); // 3 bytes: e2 82 ac
    const cut = Buffer.concat([Buffer.from('price: '), euro.subarray(0, 2)]);
    expect(toExcerpt(cut)).toBe('price: �');
  });

  it('turns invalid bytes and NULs into storable text', () => {
    expect(toExcerpt(Buffer.from([0x61, 0x00, 0xff, 0x62]))).toBe('a�b');
  });
});
