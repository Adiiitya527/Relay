import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, isAbortError } from '../src/lib/api.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake fetch that records calls and answers with the given status/body. */
function fakeFetch(status = 200, body: unknown = { data: [] }, raw?: string) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(raw ?? JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, key: string | null = 'key_123', onUnauthorized = vi.fn()) {
  return { api: createApiClient({ fetch: fetchImpl, getKey: () => key, onUnauthorized }), onUnauthorized };
}

const headersOf = (call: Call) => call.init.headers as Record<string, string>;

describe('api client', () => {
  it('sends the stored key as a Bearer token and asks for JSON', async () => {
    const f = fakeFetch();
    await client(f.fetch).api.listEndpoints();
    expect(f.calls[0]!.url).toBe('/v1/endpoints');
    expect(headersOf(f.calls[0]!)).toMatchObject({ authorization: 'Bearer key_123', accept: 'application/json' });
  });

  it('sets Content-Type only when there is a body (empty JSON body is a 400 at the API)', async () => {
    const f = fakeFetch(202, { replayed: 2 });
    const { api } = client(f.fetch);
    await api.replayDead('6f1c1a8e-1111-4222-8333-444455556666');
    await api.publish('order.created', { id: 1 });
    const [replay, publish] = f.calls;
    expect(replay!.init.method).toBe('POST');
    expect(replay!.init.body).toBeUndefined();
    expect(headersOf(replay!)).not.toHaveProperty('content-type');
    expect(headersOf(publish!)['content-type']).toBe('application/json');
    expect(JSON.parse(publish!.init.body as string)).toEqual({ event_type: 'order.created', payload: { id: 1 } });
  });

  it('builds delivery list query strings, leaving out empty filters', async () => {
    const f = fakeFetch(200, { data: [], next_cursor: null });
    const { api } = client(f.fetch);
    await api.listDeliveries({});
    await api.listDeliveries({ status: 'dead', endpointId: 'abc', cursor: 'c1', limit: 10 });
    expect(f.calls.map((c) => c.url)).toEqual([
      '/v1/deliveries?limit=50',
      '/v1/deliveries?status=dead&endpoint_id=abc&cursor=c1&limit=10',
    ]);
  });

  it('URL-encodes ids in paths', async () => {
    const f = fakeFetch(200, {});
    await client(f.fetch).api.getDelivery('a/b?c');
    expect(f.calls[0]!.url).toBe('/v1/deliveries/a%2Fb%3Fc');
  });

  it('turns the API error shape into an ApiError', async () => {
    const f = fakeFetch(409, { error: { code: 'delivery_not_replayable', message: 'Delivery is pending' } });
    const err = await client(f.fetch).api.replayDelivery('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'delivery_not_replayable', message: 'Delivery is pending' });
  });

  it('401 logs the operator out', async () => {
    const f = fakeFetch(401, { error: { code: 'unauthorized', message: 'Invalid API key' } });
    const { api, onUnauthorized } = client(f.fetch);
    await expect(api.listEndpoints()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('checkKey uses the given key and does not log out on 401', async () => {
    const f = fakeFetch(401, { error: { code: 'unauthorized', message: 'Invalid API key' } });
    const { api, onUnauthorized } = client(f.fetch, null);
    await expect(api.checkKey('candidate')).rejects.toMatchObject({ status: 401 });
    expect(headersOf(f.calls[0]!).authorization).toBe('Bearer candidate');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('a proxy 502 with a non-JSON body says the API may be down', async () => {
    const f = fakeFetch(502, undefined, 'Bad Gateway');
    await expect(client(f.fetch).api.listEndpoints()).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
      message: 'HTTP 502 (the API may be down)',
    });
  });

  it('a 200 that is not JSON is reported, not returned as undefined', async () => {
    const f = fakeFetch(200, undefined, '<!doctype html>');
    await expect(client(f.fetch).api.listEndpoints()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('a network failure becomes status 0 network_error', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(client(failing).api.listEndpoints()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('an aborted request rethrows the AbortError untouched', async () => {
    const aborting = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const err = await client(aborting).api.listEndpoints(new AbortController().signal).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('passes the abort signal through', async () => {
    const f = fakeFetch(200, { data: [] });
    const controller = new AbortController();
    await client(f.fetch).api.listEndpoints(controller.signal);
    expect(f.calls[0]!.init.signal).toBe(controller.signal);
  });
});
