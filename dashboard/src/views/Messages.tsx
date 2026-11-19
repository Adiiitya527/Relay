import { useCallback, useState, type FormEvent } from 'react';
import { Badge, Button, Card, Empty, ErrorBanner, Link, Loading, Mono, Notice, Td, Th, Time } from '../components/ui.js';
import { useSession } from '../context.js';
import { parseEventTypes } from '../lib/display.js';
import { shortId } from '../lib/format.js';
import { useNow, usePagedList } from '../lib/hooks.js';
import { parsePayloadInput } from '../lib/paging.js';
import type { Published } from '../lib/types.js';

export function Messages() {
  const { api } = useSession();
  const now = useNow();
  const fetchPage = useCallback((cursor: string | undefined, signal?: AbortSignal) => api.listMessages(cursor, signal), [api]);
  const list = usePagedList(fetchPage, 'messages');
  const [showForm, setShowForm] = useState(false);

  return (
    <>
      <Card
        title="Messages"
        actions={
          <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Close' : 'Send test event'}
          </Button>
        }
      >
        <div className="space-y-4">
          {showForm && <TestEventForm onSent={list.refresh} />}
          <ErrorBanner error={list.error} />
          {list.loading ? (
            <Loading />
          ) : list.rows.length === 0 ? (
            <Empty>No messages yet. Publish one with POST /v1/messages or "Send test event".</Empty>
          ) : (
            <table className="min-w-full divide-y divide-slate-200">
              <thead>
                <tr>
                  <Th>Message</Th>
                  <Th>Event type</Th>
                  <Th>Idempotency key</Th>
                  <Th>Published</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.rows.map((m) => (
                  <tr key={m.id}>
                    <Td>
                      <Link to={{ name: 'message', id: m.id }}>
                        <Mono title={m.id}>{shortId(m.id)}</Mono>
                      </Link>
                    </Td>
                    <Td>
                      <Badge>{m.event_type}</Badge>
                    </Td>
                    <Td>{m.idempotency_key ? <Mono>{m.idempotency_key}</Mono> : <span className="text-slate-400">—</span>}</Td>
                    <Td>
                      <Time iso={m.created_at} now={now} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
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
    </>
  );
}

function TestEventForm({ onSent }: { onSent: () => void }) {
  const { api } = useSession();
  const [eventType, setEventType] = useState('demo.test');
  const [payload, setPayload] = useState('{\n  "hello": "world"\n}');
  const [error, setError] = useState<unknown>(undefined);
  const [sent, setSent] = useState<Published | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const types = parseEventTypes(eventType);
    if (!types.ok || types.types.length !== 1) return setError(new Error(types.ok ? 'Enter exactly one event type.' : types.message));
    const parsed = parsePayloadInput(payload);
    if (!parsed.ok) return setError(new Error(parsed.message));
    setBusy(true);
    setError(undefined);
    setSent(null);
    try {
      setSent(await api.publish(types.types[0]!, parsed.payload));
      onSent();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
      <label className="block text-sm font-medium">
        Event type
        <input className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm" value={eventType} onChange={(e) => setEventType(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        Payload (JSON object)
        <textarea
          className="mt-1 block h-28 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          value={payload}
          spellCheck={false}
          onChange={(e) => setPayload(e.target.value)}
        />
      </label>
      <ErrorBanner error={error} />
      {sent && (
        <Notice>
          Published <Link to={{ name: 'message', id: sent.message.id }}>{shortId(sent.message.id)}</Link> to{' '}
          {sent.deliveries.length === 1 ? '1 endpoint' : `${sent.deliveries.length} endpoints`}
          {sent.deliveries.length === 0 && ' (no enabled endpoint subscribes to this event type)'}.
        </Notice>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Publishing…' : 'Publish'}
      </Button>
    </form>
  );
}
