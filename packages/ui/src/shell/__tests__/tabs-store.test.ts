import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTabsStore, HOME_TAB_ID, loadCachedTabs, tabsStorageKey } from "../tabs-store";

const parties = { title: "Terceros", href: "/parties", kind: "grid" as const };
const products = { title: "Productos", href: "/products", kind: "grid" as const };
const categories = { title: "Categorías", href: "/categories", kind: "grid" as const };

/** A Storage of our own: the Node global `localStorage` shadows jsdom's and is not usable here. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

let localStorage: Storage;

describe("tabs store", () => {
  beforeEach(() => {
    localStorage = memoryStorage();
  });

  it("starts with the home tab only, active and pinned", () => {
    const { tabs, activeId } = createTabsStore().getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: HOME_TAB_ID, href: "/", kind: "home", pinned: true });
    expect(activeId).toBe(HOME_TAB_ID);
  });

  it("opening the same href twice activates the existing tab instead of duplicating it", () => {
    const store = createTabsStore();
    store.getState().open(parties);
    store.getState().open(products);
    store.getState().open({ ...parties, title: "Terceros (otra vez)" });
    const { tabs, activeId } = store.getState();
    expect(tabs.map((t) => t.href)).toEqual(["/", "/parties", "/products"]);
    expect(tabs.find((t) => t.id === activeId)!.href).toBe("/parties");
  });

  it("closing the active tab activates its neighbour (the next one, else the previous one)", () => {
    const store = createTabsStore();
    for (const tab of [parties, products, categories]) store.getState().open(tab);
    const id = (href: string) => store.getState().tabs.find((t) => t.href === href)!.id;
    store.getState().activate(id("/products"));
    store.getState().close(id("/products"));
    expect(store.getState().tabs.find((t) => t.id === store.getState().activeId)!.href).toBe("/categories");
    store.getState().close(id("/categories"));
    expect(store.getState().tabs.find((t) => t.id === store.getState().activeId)!.href).toBe("/parties");
  });

  it("closing an inactive tab keeps the active one", () => {
    const store = createTabsStore();
    store.getState().open(parties);
    store.getState().open(products);
    store.getState().close(store.getState().tabs[1]!.id);
    expect(store.getState().tabs.map((t) => t.href)).toEqual(["/", "/products"]);
    expect(store.getState().tabs.find((t) => t.id === store.getState().activeId)!.href).toBe("/products");
  });

  it("the home tab cannot be closed", () => {
    const store = createTabsStore();
    store.getState().close(HOME_TAB_ID);
    expect(store.getState().tabs.map((t) => t.id)).toEqual([HOME_TAB_ID]);
  });

  it("closeAll keeps only home and activates it", () => {
    const store = createTabsStore();
    store.getState().open(parties);
    store.getState().open(products);
    store.getState().closeAll();
    expect(store.getState().tabs.map((t) => t.id)).toEqual([HOME_TAB_ID]);
    expect(store.getState().activeId).toBe(HOME_TAB_ID);
  });

  it("persists per user in localStorage under erp.tabs.<userId> and reports every change", () => {
    const onChange = vi.fn();
    const store = createTabsStore({ userId: "u1", storage: localStorage, onChange });
    store.getState().open(parties);
    expect(JSON.parse(localStorage.getItem(tabsStorageKey("u1"))!)).toMatchObject({ activeId: "/parties" });
    expect(onChange).toHaveBeenLastCalledWith({ tabs: store.getState().tabs, activeId: "/parties" });

    expect(loadCachedTabs(localStorage, "u1")!.tabs.map((t) => t.href)).toEqual(["/", "/parties"]);
    expect(loadCachedTabs(localStorage, "u2")).toBeNull();
  });

  it("hydrate restores a saved state, always keeping home first and an existing tab active", () => {
    const store = createTabsStore();
    store.getState().hydrate({
      tabs: [
        { id: "/products", title: "Productos", href: "/products", kind: "grid" },
        { id: "/products", title: "dup", href: "/products", kind: "grid" },
        { id: "bad", title: 3, href: null } as never,
      ],
      activeId: "missing",
    });
    expect(store.getState().tabs.map((t) => t.href)).toEqual(["/", "/products"]);
    expect(store.getState().activeId).toBe(HOME_TAB_ID);
  });

  it("an initial (server) state wins over the cache", () => {
    localStorage.setItem(tabsStorageKey("u1"), JSON.stringify({ tabs: [{ id: "/x", title: "X", href: "/x", kind: "grid" }], activeId: "/x" }));
    const store = createTabsStore({ userId: "u1", storage: localStorage, initial: { tabs: [{ id: "/parties", ...parties }], activeId: "/parties" } });
    expect(store.getState().tabs.map((t) => t.href)).toEqual(["/", "/parties"]);
  });
});
