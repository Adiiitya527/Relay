import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, Empty, ErrorBanner, Link, Loading, Mono, Notice, Td, Th, Time } from '../components/ui.js';
import { useSession } from '../context.js';
import { checkEndpointUrlInput, circuitBadge, parseEventTypes } from '../lib/display.js';
import { useNow, usePolled } from '../lib/hooks.js';
import type { CreatedEndpoint, Endpoint } from '../lib/types.js';

export function Endpoints() {
  const { api } = useSession();
  const now = useNow();
  const endpoints = usePolled((signal) => api.listEndpoints(signal), 'endpoints');
  const [showForm, setShowForm] = useState(false);
  const [created, setCreated] = useState<CreatedEndpoint | null>(null);
  const [actionError, setActionError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  /** Runs a button action: one error/notice slot for the page, then refreshes the list. */
  async function act(fn: () => Promise<string | void>) {
    setActionError(undefined);
    setNotice(null);
    try {
      const message = await fn();
      if (message) setNotice(message);
    } catch (err) {
      setActionError(err);
    } finally {
      endpoints.refresh();
    }
  }

  return (
    <>
      {created && <CreatedSecret endpoint={created} onDismiss={() => setCreated(null)} />}
      <Card
        title="Endpoints"
        actions={
          <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'New endpoint'}
          </Button>
        }
      >
        <div className="space-y-4">
          {showForm && (
            <CreateForm
              onCreated={(e) => {
                setCreated(e);
                setShowForm(false);
                endpoints.refresh();
              }}
            />
          )}
          <ErrorBanner error={actionError ?? endpoints.error} />
          {notice && <Notice>{notice}</Notice>}
          {endpoints.loading ? (
            <Loading />
          ) : !endpoints.data?.data.length ? (
            <Empty>No endpoints yet. Create one to start receiving webhooks.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead>
                  <tr>
                    <Th>URL</Th>
                    <Th>Event types</Th>
                    <Th>Circuit</Th>
                    <Th>Status</Th>
                    <Th>Created</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {endpoints.data.data.map((e) => (
                    <EndpointRow key={e.id} endpoint={e} now={now} act={act} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

function EndpointRow({ endpoint: e, now, act }: { endpoint: Endpoint; now: number; act: (fn: () => Promise<string | void>) => Promise<void> }) {
  const { api } = useSession();
  const [secret, setSecret] = useState<string | null>(null);
  const circuit = circuitBadge(e, now);
  return (
    <tr className={e.disabled ? 'opacity-60' : ''}>
      <Td className="max-w-xs">
        <div className="truncate font-mono text-xs" title={e.url}>
          {e.url}
        </div>
        {e.description && <div className="truncate text-xs text-slate-500">{e.description}</div>}
        {secret && (
          <div className="mt-2 flex items-center gap-2">
            <Mono>{secret}</Mono>
            <Button onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</Button>
            <Button onClick={() => setSecret(null)}>Hide</Button>
          </div>
        )}
      </Td>
      <Td>
        {e.event_types.length === 0 ? (
          <span className="text-xs text-slate-500">all</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {e.event_types.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
        )}
      </Td>
      <Td>
        <Badge tone={circuit.tone} title={circuit.title}>
          {circuit.label}
        </Badge>
      </Td>
      <Td>{e.disabled ? <Badge>disabled</Badge> : <Badge tone="good">enabled</Badge>}</Td>
      <Td>
        <Time iso={e.created_at} now={now} />
      </Td>
      <Td className="whitespace-nowrap text-right">
        <div className="flex justify-end gap-2">
          <Link to={{ name: 'deliveries', endpointId: e.id }} className="px-1 py-1.5 text-sm">
            Deliveries
          </Link>
          <Link to={{ name: 'deliveries', status: 'dead', endpointId: e.id }} className="px-1 py-1.5 text-sm">
            Dead
          </Link>
          <Button
            onClick={() =>
              act(async () => {
                const { replayed } = await api.replayDead(e.id);
                return replayed === 0 ? 'No dead deliveries to replay.' : `Replaying ${replayed} dead deliveries.`;
              })
            }
          >
            Replay dead
          </Button>
          <Button
            onClick={() =>
              act(async () => {
                setSecret((await api.getEndpointSecret(e.id)).secret);
              })
            }
          >
            Secret
          </Button>
          <Button
            onClick={() =>
              act(async () => {
                await api.updateEndpoint(e.id, { disabled: !e.disabled });
                return e.disabled ? 'Endpoint enabled; paused deliveries resume.' : 'Endpoint disabled; its deliveries are paused.';
              })
            }
          >
            {e.disabled ? 'Enable' : 'Disable'}
          </Button>
        </div>
      </Td>
    </tr>
  );
}

function CreateForm({ onCreated }: { onCreated: (e: CreatedEndpoint) => void }) {
  const { api } = useSession();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [types, setTypes] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checkedUrl = checkEndpointUrlInput(url);
    if (!checkedUrl.ok) return setError(new Error(checkedUrl.message));
    const parsed = parseEventTypes(types);
    if (!parsed.ok) return setError(new Error(parsed.message));
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await api.createEndpoint({ url: checkedUrl.url, description: description.trim(), event_types: parsed.types }));
    } catch (err) {
      setError(err); // e.g. 400 "body.url: scheme must be https" from the API
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
      <label className="block text-sm font-medium">
        URL
        <input className={`${input} font-mono`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks" />
      </label>
      <label className="block text-sm font-medium">
        Description <span className="font-normal text-slate-500">(optional)</span>
        <input className={input} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        Event types <span className="font-normal text-slate-500">(comma separated; empty = all)</span>
        <input className={`${input} font-mono`} value={types} onChange={(e) => setTypes(e.target.value)} placeholder="order.created, invoice.paid" />
      </label>
      <ErrorBanner error={error} />
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create endpoint'}
      </Button>
    </form>
  );
}

function CreatedSecret({ endpoint, onDismiss }: { endpoint: CreatedEndpoint; onDismiss: () => void }) {
  return (
    <Card title="Endpoint created" actions={<Button onClick={onDismiss}>Done</Button>}>
      <div className="space-y-2 text-sm">
        <p>
          Signing secret for <Mono>{endpoint.url}</Mono>. Your consumer uses it to verify the <Mono>webhook-signature</Mono> header.
          You can reveal it again later with <em>Secret</em>.
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs">{endpoint.secret}</code>
          <Button onClick={() => void navigator.clipboard?.writeText(endpoint.secret)}>Copy</Button>
        </div>
      </div>
    </Card>
  );
}
