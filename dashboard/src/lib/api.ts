import type {
  Attempt,
  CreatedEndpoint,
  Delivery,
  DeliveryStatus,
  Endpoint,
  MessageDetail,
  MessageSummary,
  Page,
  Published,
} from './types.js';

/** Every failure the client reports. `status` 0 = the API could not be reached at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface ApiClientOptions {
  /** Injected so tests can stub it; the app passes `window.fetch.bind(window)`. */
  fetch: typeof fetch;
  getKey: () => string | null;
  /** Called on any 401 (the key was revoked or is wrong): the app logs out. */
  onUnauthorized: () => void;
  /** Same-origin by default: the Vite dev proxy (or a reverse proxy) forwards /v1. */
  baseUrl?: string;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Use this key instead of the stored one (login check) and do not trigger logout. */
  key?: string;
}

export interface DeliveryFilter {
  status?: DeliveryStatus | undefined;
  endpointId?: string | undefined;
  cursor?: string | undefined;
  limit?: number;
}

export function createApiClient(options: ApiClientOptions) {
  const base = options.baseUrl ?? '';

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const key = opts.key ?? options.getKey();
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (key) headers.authorization = `Bearer ${key}`;
    // Content-Type ONLY when there is a body: the API answers an empty body declared as
    // JSON with 400 invalid_json (PROGRESS D62). The replay POSTs have no body.
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await options.fetch(`${base}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        ...(opts.signal && { signal: opts.signal }),
      });
    } catch (err) {
      if (isAbortError(err)) throw err; // the view moved on; callers ignore this
      throw new ApiError(0, 'network_error', 'Cannot reach the Relay API. Is it running?');
    }

    const text = await res.text();
    const json = parseJson(text);
    if (res.ok) {
      // e.g. an HTML page because the request never reached the API (misconfigured proxy).
      if (json === undefined) throw new ApiError(res.status, 'bad_response', 'Unexpected (non-JSON) response from the API');
      return json as T;
    }

    if (res.status === 401 && opts.key === undefined) options.onUnauthorized();
    const error = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      throw new ApiError(res.status, error.code, error.message);
    }
    // Not our error shape: e.g. the dev proxy's 502 when the API is down.
    const hint = res.status === 502 || res.status === 504 ? ' (the API may be down)' : '';
    throw new ApiError(res.status, 'http_error', `HTTP ${res.status}${hint}`);
  }

  const qs = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, String(v));
    const s = search.toString();
    return s ? `?${s}` : '';
  };
  const enc = encodeURIComponent;

  return {
    request,
    /** Validates a key without storing it: 200 → valid, ApiError(401) → invalid. */
    checkKey: (key: string) => request<{ data: Endpoint[] }>('GET', '/v1/endpoints', { key }).then(() => undefined),

    listEndpoints: (signal?: AbortSignal) => request<{ data: Endpoint[] }>('GET', '/v1/endpoints', { signal }),
    createEndpoint: (body: { url: string; description?: string; event_types?: string[] }) =>
      request<CreatedEndpoint>('POST', '/v1/endpoints', { body }),
    updateEndpoint: (id: string, body: { disabled?: boolean; url?: string; description?: string; event_types?: string[] }) =>
      request<Endpoint>('PATCH', `/v1/endpoints/${enc(id)}`, { body }),
    getEndpointSecret: (id: string) => request<{ secret: string }>('GET', `/v1/endpoints/${enc(id)}/secret`),
    replayDead: (endpointId: string) => request<{ replayed: number }>('POST', `/v1/endpoints/${enc(endpointId)}/replay-dead`),

    listMessages: (cursor?: string, signal?: AbortSignal) =>
      request<Page<MessageSummary>>('GET', `/v1/messages${qs({ limit: 50, cursor })}`, { signal }),
    getMessage: (id: string, signal?: AbortSignal) => request<MessageDetail>('GET', `/v1/messages/${enc(id)}`, { signal }),
    publish: (eventType: string, payload: Record<string, unknown>) =>
      request<Published>('POST', '/v1/messages', { body: { event_type: eventType, payload } }),

    listDeliveries: (f: DeliveryFilter, signal?: AbortSignal) =>
      request<Page<Delivery>>(
        'GET',
        `/v1/deliveries${qs({ status: f.status, endpoint_id: f.endpointId, cursor: f.cursor, limit: f.limit ?? 50 })}`,
        { signal },
      ),
    getDelivery: (id: string, signal?: AbortSignal) => request<Delivery>('GET', `/v1/deliveries/${enc(id)}`, { signal }),
    listAttempts: (id: string, signal?: AbortSignal) =>
      request<{ data: Attempt[] }>('GET', `/v1/deliveries/${enc(id)}/attempts`, { signal }),
    replayDelivery: (id: string) => request<{ delivery: Delivery }>('POST', `/v1/deliveries/${enc(id)}/replay`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
