// Where the Vite dev server forwards API calls. Kept separate from vite.config.ts so it can
// be unit-tested. The browser only ever talks to the Vite origin; Vite forwards these paths
// to the API, so the API needs no CORS configuration in development.

export const PROXIED_PATHS = ['/v1', '/healthz', '/metrics'] as const;
export const DEFAULT_API_URL = 'http://127.0.0.1:3000';

/** DASHBOARD_API_URL → a validated http(s) origin. Throws a readable error otherwise. */
export function apiProxyTarget(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DASHBOARD_API_URL must be an absolute http(s) URL (got "${raw}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`DASHBOARD_API_URL must use http or https (got "${url.protocol}")`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DASHBOARD_API_URL must be an origin only, e.g. http://127.0.0.1:3000');
  }
  return url.origin;
}
