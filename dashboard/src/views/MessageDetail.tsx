import { Badge, Card, Empty, ErrorBanner, Link, Loading, Mono, Td, Th, Time } from '../components/ui.js';
import { useSession } from '../context.js';
import { statusBadge } from '../lib/display.js';
import { shortId } from '../lib/format.js';
import { useNow, usePolled } from '../lib/hooks.js';

export function MessageDetail({ id }: { id: string }) {
  const { api } = useSession();
  const now = useNow();
  const message = usePolled((signal) => api.getMessage(id, signal), `message:${id}`);
  // For showing endpoint URLs next to their deliveries.
  const endpoints = usePolled((signal) => api.listEndpoints(signal), 'endpoints');
  const urlOf = (endpointId: string) => endpoints.data?.data.find((e) => e.id === endpointId)?.url;

  if (message.loading) return <Loading />;
  const m = message.data;
  if (!m) return <ErrorBanner error={message.error} />;

  return (
    <>
      <ErrorBanner error={message.error} />
      <Card title={<>Message <Mono>{m.id}</Mono></>}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">Event type</dt>
          <dd>
            <Badge>{m.event_type}</Badge>
          </dd>
          <dt className="text-slate-500">Published</dt>
          <dd>
            <Time iso={m.created_at} now={now} />
          </dd>
          <dt className="text-slate-500">Idempotency key</dt>
          <dd>{m.idempotency_key ? <Mono>{m.idempotency_key}</Mono> : '—'}</dd>
          <dt className="text-slate-500">webhook-id</dt>
          <dd>
            <Mono>{m.id}</Mono> <span className="text-xs text-slate-500">(the same on every retry, for consumer deduplication)</span>
          </dd>
        </dl>
        <h3 className="mt-4 text-sm font-medium text-slate-500">Payload</h3>
        <pre className="mt-1 max-h-96 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(m.payload, null, 2)}</pre>
      </Card>
      <Card title="Deliveries">
        {m.deliveries.length === 0 ? (
          <Empty>No endpoint was subscribed to this event type when it was published.</Empty>
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Delivery</Th>
                <Th>Endpoint</Th>
                <Th>Status</Th>
                <Th>Attempts</Th>
                <Th>Next attempt</Th>
                <Th>Last error</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {m.deliveries.map((d) => {
                const badge = statusBadge(d.status);
                return (
                  <tr key={d.id}>
                    <Td>
                      <Link to={{ name: 'delivery', id: d.id }}>
                        <Mono title={d.id}>{shortId(d.id)}</Mono>
                      </Link>
                    </Td>
                    <Td className="max-w-xs">
                      <div className="truncate font-mono text-xs" title={urlOf(d.endpoint_id) ?? d.endpoint_id}>
                        {urlOf(d.endpoint_id) ?? shortId(d.endpoint_id)}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={badge.tone} title={badge.title}>
                        {badge.label}
                      </Badge>
                    </Td>
                    <Td>{d.attempt_count}</Td>
                    <Td>{d.status === 'pending' ? <Time iso={d.next_attempt_at} now={now} /> : '—'}</Td>
                    <Td className="max-w-xs truncate text-xs text-slate-600">{d.last_error ?? '—'}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
