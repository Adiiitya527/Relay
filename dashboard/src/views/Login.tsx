import { useState, type FormEvent } from 'react';
import { Button, ErrorBanner } from '../components/ui.js';
import type { ApiClient } from '../lib/api.js';
import { ApiError } from '../lib/api.js';
import { normalizeApiKey } from '../lib/auth.js';

export function Login({ api, onLogin }: { api: ApiClient; onLogin: (key: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = normalizeApiKey(value);
    if (!parsed.ok) return setError(new Error(parsed.message));
    setBusy(true);
    setError(undefined);
    try {
      await api.checkKey(parsed.key);
      setValue('');
      onLogin(parsed.key);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? new Error('That API key is not valid.') : err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Relay</h1>
          <p className="mt-1 text-sm text-slate-600">
            Sign in with an application API key (from <code className="text-xs">npm run create-app -w server</code>).
          </p>
        </div>
        <label className="block text-sm font-medium">
          API key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            autoFocus
          />
        </label>
        <ErrorBanner error={error} />
        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? 'Checking…' : 'Sign in'}
        </Button>
        <p className="text-xs text-slate-500">The key is kept only in this tab (sessionStorage) and is sent only to this Relay API.</p>
      </form>
    </main>
  );
}
