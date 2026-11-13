import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, isDatabaseUnavailable } from '../../src/api/errors.js';
import { parse } from '../../src/api/validate.js';
import { buildTestApp, unreachablePool } from '../helpers/app.js';

// No database needed: these routes never query. The pool is never connected.
let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = unreachablePool();
  app = buildTestApp(pool, { MAX_PAYLOAD_BYTES: '1024' });
  // Test-only routes on the real app, so they get its error handler and body limit.
  app.get('/t/app-error', async () => {
    throw new AppError(409, 'something_conflicting', 'It conflicts');
  });
  app.get('/t/zod', async () => z.object({ a: z.string() }).parse({}));
  app.get('/t/validate', async () => parse(z.object({ a: z.string() }), { a: 1 }, 'body'));
  app.get('/t/bug', async () => {
    throw new Error('secret internal detail at /srv/x.ts:12');
  });
  app.get('/t/db-down', async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  });
  app.post('/t/echo', async (req) => req.body);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('error responses', () => {
  it('AppError → its status and { error: { code, message } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'something_conflicting', message: 'It conflicts' } });
  });

  it('a thrown ZodError → 400 validation_failed', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/zod' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('parse() names the location and field', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/validate' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.message).toMatch(/^body\.a: /);
  });

  it('an unexpected error → 500 internal_error without leaking its message', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/bug' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(res.body).not.toContain('secret');
  });

  it('a database connection error → 503 database_unavailable with Retry-After', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/db-down' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('database_unavailable');
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).not.toContain('5432');
  });

  it('unknown route → 404 not_found (query string not echoed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope?token=abc' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route GET /nope not found' } });
  });
});

describe('request body handling', () => {
  const post = (payload: string, contentType = 'application/json') =>
    app.inject({ method: 'POST', url: '/t/echo', payload, headers: { 'content-type': contentType } });

  it('accepts a valid JSON body', async () => {
    const res = await post('{"a":1}');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ a: 1 });
  });

  it('invalid JSON → 400 invalid_json, without echoing the body', async () => {
    const res = await post('{"a": SENTINEL');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_json');
    expect(res.body).not.toContain('SENTINEL');
  });

  it('empty JSON body → 400 invalid_json', async () => {
    const res = await post('');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_json');
  });

  it('non-JSON content type → 415 unsupported_media_type', async () => {
    const res = await post('a=1', 'application/x-www-form-urlencoded');
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('unsupported_media_type');
  });

  it('body over MAX_PAYLOAD_BYTES → 413 payload_too_large', async () => {
    const res = await post(JSON.stringify({ a: 'x'.repeat(2000) }));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });

  it.each([
    ['__proto__', '{"__proto__":{"admin":true}}'],
    ['constructor.prototype', '{"constructor":{"prototype":{"admin":true}}}'],
  ])('prototype-poisoning JSON (%s) → 400 invalid_json', async (_label, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_json');
  });
});

describe('isDatabaseUnavailable', () => {
  const withCode = (code: string) => Object.assign(new Error('x'), { code });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '08006', '08001', '57P01', '57P03', '53300', '57014'])(
    'true for code %s',
    (code) => expect(isDatabaseUnavailable(withCode(code))).toBe(true),
  );

  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    'Cannot use a pool after calling end on the pool',
  ])('true for pg message %j', (msg) => expect(isDatabaseUnavailable(new Error(msg))).toBe(true));

  it('true for an AggregateError of connection refusals (localhost → ::1 + 127.0.0.1)', () => {
    const agg = new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')], 'x');
    expect(isDatabaseUnavailable(agg)).toBe(true);
  });

  it.each(['23505', '23514', '42P01', '22P02'])('false for data/SQL error %s (those are bugs or 4xx)', (code) =>
    expect(isDatabaseUnavailable(withCode(code))).toBe(false),
  );

  it('false for non-errors and plain errors', () => {
    expect(isDatabaseUnavailable('ECONNREFUSED')).toBe(false);
    expect(isDatabaseUnavailable(new Error('boom'))).toBe(false);
  });
});
