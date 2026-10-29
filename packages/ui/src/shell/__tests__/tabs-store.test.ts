import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTabsStore, HOME_TAB_ID, loadCachedTabs, tabsStorageKey } from "../tabs-store";
import { memoryStorage } from "./intl";

const parties = { title: "Terceros", href: "/parties", kind: "grid" as const };
const products = { title: "Productos", href: "/products", kind: "grid" as const };
const categories = { title: "Categorías", href: "/categories", kind: "grid" as const };

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

  it("rename retitles the tab showing an href (a record that turned out not found), and leaves the others alone", () => {
    const store = createTabsStore();
    store.getState().open(parties);
    store.getState().open({ title: "Registro", href: "/r/core.party/x", kind: "record" });
    store.getState().rename("/r/core.party/x", "No encontrado");
    store.getState().rename("/nowhere", "Nada");
    expect(store.getState().tabs.find((t) => t.href === "/r/core.party/x")!.title).toBe("No encontrado");
    expect(store.getState().tabs.find((t) => t.href === "/parties")!.title).toBe("Terceros");
    // Same title: no change is reported.
    const before = store.getState().tabs;
    store.getState().rename("/r/core.party/x", "No encontrado");
    expect(store.getState().tabs).toBe(before);
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

  it("caches every change per user under erp.tabs.<userId> with its time and company, and reports it", () => {
    const onChange = vi.fn();
    const store = createTabsStore({ userId: "u1", companyId: "c1", storage: localStorage, onChange, now: () => 1000 });
    store.getState().open(parties);
    expect(JSON.parse(localStorage.getItem(tabsStorageKey("u1"))!)).toMatchObject({ companyId: "c1", savedAt: 1000, value: { activeId: "/parties" } });
    expect(onChange).toHaveBeenLastCalledWith({ tabs: store.getState().tabs, activeId: "/parties" }, 1000);

    expect(loadCachedTabs(localStorage, "u1", "c1")).toMatchObject({ savedAt: 1000 });
    expect(loadCachedTabs(localStorage, "u1", "c1")!.value.tabs.map((t) => t.href)).toEqual(["/", "/parties"]);
    expect(loadCachedTabs(localStorage, "u2", "c1")).toBeNull();
    // Another company's tabs are not this company's.
    expect(loadCachedTabs(localStorage, "u1", "c2")).toBeNull();
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

  it("starts from the initial (server) state; the cache is consulted only by the shell, after mounting", () => {
    localStorage.setItem(tabsStorageKey("u1"), JSON.stringify({ value: { tabs: [{ id: "/x", title: "X", href: "/x", kind: "grid" }], activeId: "/x" }, savedAt: 1, companyId: "c1" }));
    const store = createTabsStore({ userId: "u1", companyId: "c1", storage: localStorage, initial: { tabs: [{ id: "/parties", ...parties }], activeId: "/parties" } });
    expect(store.getState().tabs.map((t) => t.href)).toEqual(["/", "/parties"]);
  });
});
