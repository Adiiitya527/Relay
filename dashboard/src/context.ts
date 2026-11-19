import { createContext, useContext } from 'react';
import type { ApiClient } from './lib/api.js';

export interface Session {
  api: ApiClient;
  logout: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside <SessionContext.Provider>');
  return session;
}
