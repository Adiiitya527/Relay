import { Fragment, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBanner, Link, Loading, Mono, Notice, Td, Th, Time } from '../components/ui.js';
import { useSession } from '../context.js';
import { attemptOutcome, canReplay, markReplays, statusBadge } from '../lib/display.js';
import { formatDuration, shortId } from '../lib/format.js';
import { useNow, usePolled } from '../lib/hooks.js';

export function DeliveryDetail({ id }: { id: string }) {
  const { api } = useSession();
  const now = useNow();
  // One poll for both, so the status and the timeline never disagree on screen.
  const detail = usePolled(async (signal) => {
    const [delivery, attempts] = await Promise.all([api.getDelivery(id, signal), api.listAttempts(id, signal)]);
    return { delivery, attempts: attempts.data };
  }, `delivery:${id}`);
  const endpoints = usePolled((signal) => api.listEndpoints(signal), 'endpoints');
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  if (detail.loading) return <Loading />;
  if (!detail.data) return <ErrorBanner error={detail.error} />;
  const { delivery: d, attempts } = detail.data;
  const url = endpoints.data?.data.find((e) => e.id === d.endpoint_id)?.url;
  const badge = statusBadge(d.status);

  async function replay() {
    setActionError(undefined);
    setNotice(null);
    try {
      await api.replayDelivery(d.id);
      setNotice('Queued again. Attempts start at 1; earlier attempts stay in the timeline.');
    } catch (err) {
      setActionError(err);
    } finally {
      detail.refresh();
    }
  }

  return (
    <>
      <Card
        title={<>Delivery <Mono>{d.id}</Mono></>}
        actions={canReplay(d.status) && <Button variant="primary" onClick={() => void replay()}>Replay</Button>}
      >
        <div className="space-y-3">
          <ErrorBanner error={actionError ?? detail.error} />
          {notice && <Notice>{notice}</Notice>}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-slate-500">Status</dt>
            <dd>
              <Badge tone={badge.tone} title={badge.title}>
                {badge.label}
              </Badge>
            </dd>
            <dt className="text-slate-500">Message</dt>
            <dd>
              <Link to={{ name: 'message', id: d.message_id }}>
                <Mono>{d.message_id}</Mono>
              </Link>{' '}
              <Badge>{d.event_type}</Badge>
            </dd>
            <dt className="text-slate-500">Endpoint</dt>
            <dd className="break-all font-mono text-xs">{url ?? d.endpoint_id}</dd>
            <dt className="text-slate-500">Attempts</dt>
            <dd>{d.attempt_count}</dd>
            {d.status === 'pending' && (
              <>
                <dt className="text-slate-500">Next attempt</dt>
                <dd>
                  <Time iso={d.next_attempt_at} now={now} />
                </dd>
              </>
            )}
            <dt className="text-slate-500">Created</dt>
            <dd>
              <Time iso={d.created_at} now={now} />
            </dd>
            <dt className="text-slate-500">Completed</dt>
            <dd>
              <Time iso={d.completed_at} now={now} />
            </dd>
            <dt className="text-slate-500">Last error</dt>
            <dd className="text-xs">{d.last_error ?? '—'}</dd>
          </dl>
        </div>
      </Card>
      <Card title="Attempt timeline">
        {attempts.length === 0 ? (
          <Empty>No attempts yet.</Empty>
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Recorded</Th>
                <Th>Outcome</Th>
                <Th>Duration</Th>
                <Th>Worker</Th>
                <Th>Response / error</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {markReplays(attempts).map((a) => {
                const outcome = attemptOutcome(a);
                return (
                  <Fragment key={a.id}>
                    {a.afterReplay && (
                      <tr>
                        <td colSpan={6} className="bg-slate-50 px-3 py-1 text-xs font-medium text-slate-500">
                          ↻ replayed
                        </td>
                      </tr>
                    )}
                    <tr>
                      <Td>{a.attempt_number}</Td>
                      <Td className="whitespace-nowrap">
                        <Time iso={a.recorded_at} now={now} />
                      </Td>
                      <Td>
                        <Badge tone={outcome.tone} title={outcome.title}>
                          {outcome.label}
                        </Badge>
                      </Td>
                      <Td className="whitespace-nowrap">{formatDuration(a.duration_ms)}</Td>
                      <Td>
                        <Mono title={a.worker_id}>{a.worker_id.length > 24 ? `${a.worker_id.slice(0, 24)}…` : a.worker_id}</Mono>
                      </Td>
                      <Td className="max-w-md">
                        {a.error_message && <div className="text-xs text-rose-700">{a.error_message}</div>}
                        {a.response_excerpt && (
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 text-xs">
                            {a.response_excerpt}
                          </pre>
                        )}
                      </Td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Response excerpts are the first 1 KB of the endpoint&apos;s reply. Delivery {shortId(d.id)} is sent with{' '}
          <Mono>webhook-id: {d.message_id}</Mono> on every attempt.
        </p>
      </Card>
    </>
  );
}
