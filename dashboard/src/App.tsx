import { useMemo, useState } from 'react';
import { Button, Card, Link } from './components/ui.js';
import { SessionContext, useSession, type Session } from './context.js';
import { createApiClient } from './lib/api.js';
import { createKeyStore } from './lib/auth.js';
import { useRoute } from './lib/hooks.js';
import type { Route } from './lib/router.js';
import { Login } from './views/Login.js';

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined; // blocked site data: keep the key in memory only
  }
}

export function App() {
  const keyStore = useMemo(() => createKeyStore(safeSessionStorage()), []);
  const [key, setKey] = useState<string | null>(() => keyStore.get());

  const session = useMemo<Session>(() => {
    const logout = () => {
      keyStore.clear();
      setKey(null);
    };
    const api = createApiClient({ fetch: window.fetch.bind(window), getKey: () => keyStore.get(), onUnauthorized: logout });
    return { api, logout };
  }, [keyStore]);

  if (!key) {
    return (
      <Login
        api={session.api}
        onLogin={(k) => {
          keyStore.set(k);
          setKey(k);
        }}
      />
    );
  }
  return (
    <SessionContext.Provider value={session}>
      <Shell />
    </SessionContext.Provider>
  );
}

const NAV: { label: string; to: Route; active: (r: Route) => boolean }[] = [
  { label: 'Endpoints', to: { name: 'endpoints' }, active: (r) => r.name === 'endpoints' },
  { label: 'Messages', to: { name: 'messages' }, active: (r) => r.name === 'messages' || r.name === 'message' },
  {
    label: 'Deliveries',
    to: { name: 'deliveries' },
    active: (r) => (r.name === 'deliveries' && r.status !== 'dead') || r.name === 'delivery',
  },
  { label: 'Dead letters', to: { name: 'deliveries', status: 'dead' }, active: (r) => r.name === 'deliveries' && r.status === 'dead' },
];

function Shell() {
  const route = useRoute();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="font-semibold">Relay</span>
          <nav className="flex gap-1">
            {NAV.map((item) => (
              <Link
                key={item.label}
                to={item.to}
                className={`rounded-md px-3 py-1.5 text-sm hover:no-underline ${item.active(route) ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <View route={route} />
      </main>
    </div>
  );
}

function LogoutButton() {
  const { logout } = useSession();
  return (
    <Button className="ml-auto" onClick={logout}>
      Sign out
    </Button>
  );
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'not_found':
      return (
        <Card title="Not found">
          <p className="text-sm">
            Nothing here. <Link to={{ name: 'endpoints' }}>Go to endpoints</Link>
          </p>
        </Card>
      );
    default:
      return <Card title={route.name}>Coming in the next steps.</Card>;
  }
}
