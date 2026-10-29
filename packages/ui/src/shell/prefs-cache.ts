import type { Saved } from "./types";

// The browser cache of the shell's preferences (theme, tabs, assistant drawer). The server copy in `kernel.user_prefs` and this
// cache both carry `savedAt`; the shell keeps whichever is newer, so a change the server never received (the
// tab closed before the save went out) is not lost. Entries carry the company: prefs are per company.

interface CachedPref<T> extends Saved<T> {
  companyId: string;
}

/** The browser's localStorage, or null on the server and where the browser refuses access (private mode, blocked data). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const themeStorageKey = (userId: string): string => `erp.theme.${userId}`;
export const assistantOpenStorageKey = (userId: string): string => `erp.assistant.open.${userId}`;

/** The cached value under `key` for `companyId`, or null (missing, another company's, unreadable). */
export function readCachedPref(storage: Storage | null | undefined, key: string, companyId: string): Saved<unknown> | null {
  try {
    const text = storage?.getItem(key);
    if (!text) return null;
    const entry = JSON.parse(text) as Partial<CachedPref<unknown>> | null;
    if (!entry || entry.companyId !== companyId || typeof entry.savedAt !== "number" || !Number.isFinite(entry.savedAt) || !("value" in entry)) return null;
    return { value: entry.value, savedAt: entry.savedAt };
  } catch {
    return null;
  }
}

export function writeCachedPref(storage: Storage | null | undefined, key: string, companyId: string, saved: Saved<unknown>): void {
  try {
    storage?.setItem(key, JSON.stringify({ value: saved.value, savedAt: saved.savedAt, companyId } satisfies CachedPref<unknown>));
  } catch {
    // A full or blocked storage only loses the cache; the server copy remains.
  }
}

/** The newer of the server's and the cache's copy (the server's on a tie), or null when there is neither. */
export function newerSaved<T>(server: Saved<T> | null | undefined, cached: Saved<T> | null | undefined): Saved<T> | null {
  if (!server) return cached ?? null;
  if (!cached) return server;
  return cached.savedAt > server.savedAt ? cached : server;
}
