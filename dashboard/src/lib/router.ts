import { DELIVERY_STATUSES, type DeliveryStatus } from './types.js';

// A tiny hash router: six views do not justify a routing library. Hash URLs (#/messages/…)
// need no server-side fallback, so the built files can be served by any static server.
//
//   #/endpoints
//   #/messages
//   #/messages/<uuid>
//   #/deliveries[?status=dead&endpoint=<uuid>]
//   #/deliveries/<uuid>

export type Route =
  | { name: 'endpoints' }
  | { name: 'messages' }
  | { name: 'message'; id: string }
  | { name: 'deliveries'; status?: DeliveryStatus; endpointId?: string }
  | { name: 'delivery'; id: string }
  | { name: 'not_found' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?', 2);
  const segments = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart);

  if (segments.length === 0) return { name: 'endpoints' };
  const [section, id, ...rest] = segments;
  if (rest.length > 0) return { name: 'not_found' };

  switch (section) {
    case 'endpoints':
      return id === undefined ? { name: 'endpoints' } : { name: 'not_found' };
    case 'messages':
      if (id === undefined) return { name: 'messages' };
      return UUID.test(id) ? { name: 'message', id: id.toLowerCase() } : { name: 'not_found' };
    case 'deliveries': {
      if (id !== undefined) return UUID.test(id) ? { name: 'delivery', id: id.toLowerCase() } : { name: 'not_found' };
      const route: Route = { name: 'deliveries' };
      const status = query.get('status');
      if (status && (DELIVERY_STATUSES as readonly string[]).includes(status)) route.status = status as DeliveryStatus;
      const endpoint = query.get('endpoint');
      if (endpoint && UUID.test(endpoint)) route.endpointId = endpoint.toLowerCase();
      return route;
    }
    default:
      return { name: 'not_found' };
  }
}

export function formatHash(route: Route): string {
  switch (route.name) {
    case 'endpoints':
    case 'not_found':
      return '#/endpoints';
    case 'messages':
      return '#/messages';
    case 'message':
      return `#/messages/${route.id}`;
    case 'delivery':
      return `#/deliveries/${route.id}`;
    case 'deliveries': {
      const query = new URLSearchParams();
      if (route.status) query.set('status', route.status);
      if (route.endpointId) query.set('endpoint', route.endpointId);
      const s = query.toString();
      return s ? `#/deliveries?${s}` : '#/deliveries';
    }
  }
}
