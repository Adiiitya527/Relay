import { useCallback, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBanner, Link, Loading, Mono, Notice, Td, Th, Time } from '../components/ui.js';
import { useSession } from '../context.js';
import { canReplay, deadByEndpoint, statusBadge } from '../lib/display.js';
import { shortId } from '../lib/format.js';
import { navigate, useNow, usePagedList, usePolled } from '../lib/hooks.js';
import { DELIVERY_STATUSES, type DeliveryStatus } from '../lib/types.js';

/** The deliveries list. With status=dead it is the dead-letter queue. */
export function Deliveries({ status, endpointId }: { status?: DeliveryStatus | undefined; endpointId?: string | undefined }) {
  const { api } = useSession();
  const now = useNow();
  const fetchPage = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) => api.listDeliveries({ status, endpointId, cursor }, signal),
    [api, status, endpointId],
  );
  const list = usePagedList(fetchPage, `deliveries:${status ?? '*'}:${endpointId ?? '*'}`);
  const endpoints = usePolled((signal) => api.listEndpoints(signal), 'endpoints');
  const urlOf = (id: string) => endpoints.data?.data.find((e) => e.id === id)?.url;
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const isDlq = status === 'dead';

  async function act(fn: () => Promise<string>) {
    setActionError(undefined);
    setNotice(null);
    try {
      setNotice(await fn());
    } catch (err) {
      setActionError(err);
    } finally {
      list.refresh();
    }
  }
  const replayOne = (id: string) =>
    act(async () => {
      await api.replayDelivery(id);
      return `Delivery ${shortId(id)} queued again.`;
    });
  const replayAllFor = (id: string) => {
    const label = urlOf(id) ?? shortId(id);
    if (!window.confirm(`Replay every dead delivery for ${label}?`)) return;
    void act(async () => {
      const { replayed } = await api.replayDead(id);
      return `Replaying ${replayed} dead ${replayed === 1 ? 'delivery' : 'deliveries'} for ${label}.`;
    });
  };
  const bulkTargets = isDlq ? (endpointId ? [{ endpointId, shown: list.rows.length }] : deadByEndpoint(list.rows)) : [];

  return (
    <Card title={isDlq ? 'Dead-letter queue' : 'Deliveries'}>
      <div className="space-y-4">
        {isDlq && (
          <p className="text-sm text-slate-600">
            Deliveries that failed every attempt. Fix the endpoint, then replay: attempts start again at 1 and the history is kept.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {[undefined, ...DELIVERY_STATUSES].map((s) => (
            <Button
              key={s ?? 'all'}
              variant={s === status ? 'primary' : 'secondary'}
              onClick={() => navigate({ name: 'deliveries', ...(s && { status: s }), ...(endpointId && { endpointId }) })}
            >
              {s ? statusBadge(s).label : 'all'}
            </Button>
          ))}
          <select
            className="ml-auto rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            value={endpointId ?? ''}
            onChange={(e) => navigate({ name: 'deliveries', ...(status && { status }), ...(e.target.value && { endpointId: e.target.value }) })}
          >
            <option value="">All endpoints</option>
            {endpoints.data?.data.map((e) => (
              <option key={e.id} value={e.id}>
                {e.url}
              </option>
            ))}
          </select>
        </div>
        {bulkTargets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {bulkTargets.map((t) => (
              <Button key={t.endpointId} variant="danger" onClick={() => replayAllFor(t.endpointId)}>
                Replay all dead for {urlOf(t.endpointId) ?? shortId(t.endpointId)}
              </Button>
            ))}
          </div>
        )}
        <ErrorBanner error={actionError ?? list.error} />
        {notice && <Notice>{notice}</Notice>}
        {list.loading ? (
          <Loading />
        ) : list.rows.length === 0 ? (
          <Empty>{isDlq ? 'Nothing in the dead-letter queue.' : 'No deliveries match.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead>
                <tr>
                  <Th>Delivery</Th>
                  <Th>Event</Th>
                  <Th>Endpoint</Th>
                  <Th>Status</Th>
                  <Th>Attempts</Th>
                  <Th>When</Th>
                  <Th>Last error</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.rows.map((d) => {
                  const badge = statusBadge(d.status);
                  return (
                    <tr key={d.id}>
                      <Td>
                        <Link to={{ name: 'delivery', id: d.id }}>
                          <Mono title={d.id}>{shortId(d.id)}</Mono>
                        </Link>
                      </Td>
                      <Td>
                        <Badge>{d.event_type}</Badge>
                      </Td>
                      <Td className="max-w-[14rem]">
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
                      <Td className="whitespace-nowrap text-xs">
                        {d.status === 'pending' ? (
                          <>
                            next <Time iso={d.next_attempt_at} now={now} />
                          </>
                        ) : d.completed_at ? (
                          <Time iso={d.completed_at} now={now} />
                        ) : (
                          <Time iso={d.updated_at} now={now} />
                        )}
                      </Td>
                      <Td className="max-w-[16rem] truncate text-xs text-slate-600">{d.last_error ?? '—'}</Td>
                      <Td className="text-right">
                        {canReplay(d.status) && <Button onClick={() => void replayOne(d.id)}>Replay</Button>}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.hasMore && (
          <div className="text-center">
            <Button onClick={list.loadMore} disabled={list.loadingMore}>
              {list.loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
