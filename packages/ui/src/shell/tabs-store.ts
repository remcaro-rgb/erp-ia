"use client";

import { createContext, createElement, useContext, type ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import { HOME_TAB, HOME_TAB_ID, MAX_TABS, sanitizeTabs, tabsStorageKey } from "./tabs-model";
import type { Tab, TabsSnapshot } from "./types";

export { HOME_TAB_ID, loadCachedTabs, MAX_TABS, sanitizeTabs, tabsStorageKey } from "./tabs-model";

// The open-screen tabs (design §19a, prototype `tabs`/`closeTab`/`closeAllTabs`). One store per signed-in user:
// the server's copy in `kernel.user_prefs` is the truth; localStorage (`erp.tabs.<userId>`) is an optimistic
// cache that fills the bar before the server answers and when the server has nothing yet.

export interface TabsActions {
  /** Opens a tab, or activates the one already showing `href`. The id defaults to the href. */
  open(tab: Omit<Tab, "id"> & { id?: string }): void;
  /** Closes a tab (never a pinned one); closing the active tab activates its neighbour. */
  close(id: string): void;
  activate(id: string): void;
  /** Keeps only the pinned tabs (Inicio) and activates Inicio. */
  closeAll(): void;
  /** Replaces the state with a saved one, repaired (home first, no duplicate hrefs, an existing active tab). */
  hydrate(snapshot: unknown): void;
}

export type TabsState = TabsSnapshot & TabsActions;
export type TabsStore = StoreApi<TabsState>;

export interface TabsStoreOptions {
  /** Owner of the tabs; with `storage`, every change is cached under `erp.tabs.<userId>`. */
  userId?: string;
  storage?: Storage | null;
  /** The server's copy (`kernel.user_prefs`, key `tabs`); wins over the cache. */
  initial?: unknown;
  /** Called after every change, e.g. to save to `kernel.user_prefs`. */
  onChange?: (snapshot: TabsSnapshot) => void;
}

export function createTabsStore(options: TabsStoreOptions = {}): TabsStore {
  const { userId, storage, onChange } = options;
  const store = createStore<TabsState>()((set, get) => ({
    ...sanitizeTabs(options.initial),
    open(tab) {
      const existing = get().tabs.find((t) => t.href === tab.href);
      if (existing) {
        if (existing.id !== get().activeId) set({ activeId: existing.id });
        return;
      }
      const id = tab.id ?? tab.href;
      const next: Tab = { id, title: tab.title, href: tab.href, kind: tab.kind, ...(tab.pinned ? { pinned: true } : {}) };
      let tabs = [...get().tabs.filter((t) => t.id !== id), next];
      while (tabs.length > MAX_TABS) {
        const oldest = tabs.findIndex((t) => !t.pinned && t.id !== id);
        if (oldest < 0) break;
        tabs = tabs.filter((_, i) => i !== oldest);
      }
      set({ tabs, activeId: id });
    },
    close(id) {
      const { tabs, activeId } = get();
      const index = tabs.findIndex((t) => t.id === id);
      if (index < 0 || tabs[index]!.pinned) return;
      const rest = tabs.filter((t) => t.id !== id);
      const nextActive = id === activeId ? (rest[index] ?? rest[index - 1] ?? HOME_TAB).id : activeId;
      set({ tabs: rest, activeId: nextActive });
    },
    activate(id) {
      if (get().tabs.some((t) => t.id === id) && get().activeId !== id) set({ activeId: id });
    },
    closeAll() {
      set({ tabs: get().tabs.filter((t) => t.pinned), activeId: HOME_TAB_ID });
    },
    hydrate(snapshot) {
      set(sanitizeTabs(snapshot));
    },
  }));

  store.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeId === previous.activeId) return;
    const snapshot: TabsSnapshot = { tabs: state.tabs, activeId: state.activeId };
    if (userId && storage) {
      try {
        storage.setItem(tabsStorageKey(userId), JSON.stringify(snapshot));
      } catch {
        // A full or blocked storage only loses the cache; the server copy remains.
      }
    }
    onChange?.(snapshot);
  });
  return store;
}

const TabsContext = createContext<TabsStore | null>(null);

export function TabsProvider({ store, children }: { store: TabsStore; children: ReactNode }) {
  return createElement(TabsContext.Provider, { value: store }, children);
}

export function useTabsStore(): TabsStore {
  const store = useContext(TabsContext);
  if (!store) throw new Error("useTabs must be used inside <TabsProvider>");
  return store;
}

/** The open tabs and their actions (brief interface), from the nearest `<TabsProvider>`. */
export function useTabs<T = TabsState>(selector?: (state: TabsState) => T): T {
  return useStore(useTabsStore(), selector ?? ((state) => state as unknown as T));
}
