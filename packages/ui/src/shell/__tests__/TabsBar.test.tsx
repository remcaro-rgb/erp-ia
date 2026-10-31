// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { TabsBar } from "../TabsBar";
import { createTabsStore, HOME_TAB_ID, TabsProvider } from "../tabs-store";
import { renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
afterEach(cleanup);

function setup() {
  const store = createTabsStore();
  store.getState().open({ title: "Terceros", href: "/parties", kind: "grid" });
  store.getState().open({ title: "Productos", href: "/products", kind: "grid" });
  const onNew = vi.fn();
  renderEs(
    <TabsProvider store={store}>
      <TabsBar onNew={onNew} />
    </TabsProvider>,
  );
  return { store, onNew };
}

describe("TabsBar", () => {
  it("renders the open tabs, the active one marked, home without a close button", () => {
    setup();
    const bar = screen.getByRole("navigation", { name: "Pestañas abiertas" });
    expect(within(bar).getByRole("button", { name: "Inicio" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Productos" }).getAttribute("aria-current")).toBe("page");
    expect(within(bar).queryByRole("button", { name: "Cerrar Inicio" })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Cerrar Terceros" })).toBeTruthy();
  });

  it("a click activates a tab; its close button closes it", () => {
    const { store } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Terceros" }));
    expect(store.getState().activeId).toBe("/parties");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar Terceros" }));
    expect(store.getState().tabs.map((t) => t.href)).toEqual(["/", "/products"]);
  });

  it("+ opens the palette", () => {
    const { onNew } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Nueva pestaña" }));
    expect(onNew).toHaveBeenCalled();
  });

  it("Cerrar todas asks for confirmation; Cancelar keeps the tabs", () => {
    const { store } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Cerrar todas/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("2 pestañas");
    expect(dialog.textContent).toContain("Terceros, Productos");
    expect(dialog.textContent).toContain("Inicio permanece abierta");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(store.getState().tabs).toHaveLength(3);
  });

  it("confirming Cerrar todas keeps only Inicio", () => {
    const { store } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Cerrar todas/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cerrar todas" }));
    expect(store.getState().tabs.map((t) => t.id)).toEqual([HOME_TAB_ID]);
    expect(store.getState().activeId).toBe(HOME_TAB_ID);
    expect(screen.queryByRole("button", { name: /Cerrar todas/ })).toBeNull();
  });

  // UI density audit quick win 14 (L5): the row is one tab stop, ← → move between the tabs, Delete closes the focused
  // tab and the caret goes to its neighbour; the ✕ is a 20 px mouse target out of the tab order.
  it("moves between tabs with ← →, closes the focused one with Delete, and keeps ✕ out of the tab order", () => {
    const { store } = setup();
    const bar = screen.getByRole("navigation", { name: "Pestañas abiertas" });
    const title = (name: string) => within(bar).getByRole("button", { name });
    expect(title("Productos").tabIndex).toBe(0);
    expect(title("Inicio").tabIndex).toBe(-1);
    expect(title("Terceros").tabIndex).toBe(-1);
    const close = within(bar).getByRole("button", { name: "Cerrar Terceros" });
    expect(close.tabIndex).toBe(-1);
    expect(close.className).toContain("size-5");
    title("Productos").focus();
    fireEvent.keyDown(title("Productos"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(title("Inicio"));
    fireEvent.keyDown(title("Inicio"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(title("Terceros"));
    // Moving does not activate: Enter (a click) does.
    expect(store.getState().activeId).toBe("/products");
    // Inicio does not close.
    fireEvent.keyDown(title("Terceros"), { key: "ArrowLeft" });
    fireEvent.keyDown(title("Inicio"), { key: "Delete" });
    expect(store.getState().tabs).toHaveLength(3);
    fireEvent.keyDown(title("Inicio"), { key: "ArrowRight" });
    fireEvent.keyDown(title("Terceros"), { key: "Delete" });
    expect(store.getState().tabs.map((t) => t.href)).toEqual(["/", "/products"]);
    expect(document.activeElement).toBe(title("Productos"));
  });
});

// Phase 1b task 1 (OD-6): the row scrolls sideways instead of clipping; the active tab is kept in view; "+" and
// "Cerrar todas" stay pinned at the right, outside the scrolling area.
describe("TabsBar with many tabs", () => {
  const many = (count: number, active: number) => {
    const store = createTabsStore();
    for (let i = 1; i <= count; i++) store.getState().open({ title: `Pantalla ${i}`, href: `/p${i}`, kind: "grid" });
    store.getState().activate(`/p${active}`);
    renderEs(
      <TabsProvider store={store}>
        <TabsBar onNew={vi.fn()} />
      </TabsProvider>,
    );
    return store;
  };
  const scroller = () => document.querySelector<HTMLElement>("[data-tabs-scroll]")!;

  it("scrolls the tabs sideways (no clipping) and keeps the active tab in view", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const store = many(20, 18);
    expect(scroller().className).toContain("overflow-x-auto");
    expect(scroller().className).not.toContain("overflow-hidden");
    const shown = spy.mock.contexts.map((el) => (el as HTMLElement).getAttribute("data-tab"));
    expect(shown).toContain("/p18");
    expect(spy.mock.calls.at(-1)![0]).toEqual({ block: "nearest", inline: "nearest" });
    // Activating another tab scrolls to that one.
    spy.mockClear();
    act(() => store.getState().activate("/p3"));
    expect((spy.mock.contexts.at(-1) as HTMLElement).getAttribute("data-tab")).toBe("/p3");
    spy.mockRestore();
  });

  it("keeps + and Cerrar todas pinned at the right, outside the scrolling area, and visible", () => {
    many(20, 20);
    const plus = screen.getByRole("button", { name: "Nueva pestaña" });
    const closeAll = screen.getByRole("button", { name: /Cerrar todas/ });
    expect(scroller().contains(plus)).toBe(false);
    expect(scroller().contains(closeAll)).toBe(false);
    expect(scroller().contains(screen.getByRole("button", { name: "Pantalla 20" }))).toBe(true);
    expect(plus.closest("[data-tabs-row]")).toBe(scroller().closest("[data-tabs-row]"));
    expect(plus.className).toContain("shrink-0");
    expect(closeAll.className).toContain("shrink-0");
  });

  it("keeps the keyboard behaviour: one tab stop, ← → move, Delete closes", () => {
    const store = many(20, 5);
    const title = (name: string) => screen.getByRole("button", { name });
    expect(title("Pantalla 5").tabIndex).toBe(0);
    expect(title("Pantalla 6").tabIndex).toBe(-1);
    title("Pantalla 5").focus();
    fireEvent.keyDown(title("Pantalla 5"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(title("Pantalla 6"));
    fireEvent.keyDown(title("Pantalla 6"), { key: "Delete" });
    expect(store.getState().tabs.some((t) => t.href === "/p6")).toBe(false);
  });
});

describe("TabsBar touch targets (rule 24, T5)", () => {
  it("the close control and the row grow to 44 px on coarse pointers and under 768 px, and stay compact otherwise", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "TabsBar.tsx"), "utf8");
    expect(source).toMatch(/size-5 max-md:size-11 \[@media\(pointer:coarse\)\]:size-11/);
    expect(source).toMatch(/h-9 shrink-0[^"]*max-md:h-12 \[@media\(pointer:coarse\)\]:h-12/);
  });
});
