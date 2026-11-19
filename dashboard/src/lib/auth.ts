// Where the operator's API key lives in the browser.
//
// sessionStorage, not localStorage: it is scoped to this tab and gone when the tab closes, so
// a key pasted on a shared machine does not linger. It is never put in a URL (URLs end up in
// history, logs and Referer headers) and never logged. Storage can be unavailable (privacy
// mode, blocked site data): every access is guarded and the app then simply keeps the key in
// memory for this page load.

export const STORAGE_KEY = 'relay.apiKey';

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function createKeyStore(storage: KeyStorage | undefined) {
  let memory: string | null = null;
  return {
    get(): string | null {
      try {
        return storage?.getItem(STORAGE_KEY) ?? memory;
      } catch {
        return memory;
      }
    },
    set(key: string): void {
      memory = key;
      try {
        storage?.setItem(STORAGE_KEY, key);
      } catch {
        // memory only
      }
    },
    clear(): void {
      memory = null;
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // nothing stored
      }
    },
  };
}

export type KeyStore = ReturnType<typeof createKeyStore>;

/**
 * Light client-side check before calling the API: trims whitespace and refuses values that
 * cannot be a key (empty, contain spaces, absurdly long). The API decides validity.
 */
export function normalizeApiKey(input: string): { ok: true; key: string } | { ok: false; message: string } {
  const key = input.trim().replace(/^Bearer\s+/i, '');
  if (!key) return { ok: false, message: 'Paste an API key.' };
  if (/\s/.test(key)) return { ok: false, message: 'An API key contains no spaces.' };
  if (key.length > 200) return { ok: false, message: 'That is too long to be an API key.' };
  return { ok: true, key };
}
