import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/messages/query.js';

const ID = '0b6f9a1e-3c2d-4e5f-8a9b-0c1d2e3f4a5b';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('message list cursor', () => {
  it('round-trips exactly (microseconds kept as a string)', () => {
    const cursor = { micros: '1794873600123456', id: ID };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no padding
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it('normalises the id to lower case', () => {
    expect(decodeCursor(b64(`1|${ID.toUpperCase()}`))?.id).toBe(ID);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['no separator', b64(`1794873600123456${ID}`)],
    ['non-numeric time', b64(`12x|${ID}`)],
    ['negative time', b64(`-1|${ID}`)],
    ['too many digits', b64(`12345678901234567|${ID}`)],
    ['bad uuid', b64('1794873600123456|not-a-uuid')],
    ['extra field', b64(`1|${ID}|x`)],
    ['SQL in the id', b64(`1|${ID}' OR '1'='1`)],
    ['huge input', 'A'.repeat(500)],
  ])('rejects %s', (_label, value) => {
    expect(decodeCursor(value)).toBeUndefined();
  });
});
