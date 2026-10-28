// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppShell } from "../AppShell";
import type { NavItem } from "../types";
import { tabsStorageKey } from "../tabs-store";
import { memoryStorage, renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

const nav: NavItem[] = [
  { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" },
  { id: "core.products", label: "nav.core.products", href: "/products", icon: "package" },
  { id: "core.categories", label: "nav.core.categories", href: "/categories", icon: "tags" },
];

type ShellProps = Parameters<typeof AppShell>[0];
const cafe = { id: "c1", name: "Café del Norte S.A.S.", taxId: "900373115" };
const otra = { id: "c2", name: "Otra Empresa S.A.S.", taxId: "900000001" };

function shellElement(currentHref: string, navigate = vi.fn(), extra: Partial<ShellProps> = {}) {
  return (
    <AppShell
      company={cafe}
      companies={[cafe, otra]}
      user={{ id: "u1", name: "Laura Martínez", email: "laura@demo.local", roles: ["admin"] }}
      modules={[{ id: "core", label: "nav.modules.core" }]}
      nav={nav}
      currentHref={currentHref}
      navigate={navigate}
      storage={memoryStorage()}
      {...extra}
    >
      <p>contenido</p>
    </AppShell>
  );
}

const shell = (currentHref: string, navigate = vi.fn(), extra: Partial<ShellProps> = {}) => renderEs(shellElement(currentHref, navigate, extra));
/** Titles of the open tabs (the title buttons are the ones without an aria-label or a tooltip). */
const tabNames = () =>
  within(screen.getByRole("navigation", { name: "Pestañas abiertas" }))
    .getAllByRole("button")
    .filter((b) => !b.getAttribute("aria-label") && !b.getAttribute("title"))
    .map((b) => b.textContent ?? "");

describe("AppShell", () => {
  it("shows the active module's items next to the module button, the current one marked", () => {
    shell("/parties");
    expect(screen.getByRole("button", { name: /^Núcleo/ })).toBeTruthy();
    const items = within(screen.getByRole("navigation", { name: "Menú del módulo" })).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["Inicio", "Terceros", "Productos", "Categorías"]);
    expect(items[1]!.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("LM")).toBeTruthy();
  });

  it("the page being shown opens its tab, and a module item navigates", () => {
    const navigate = vi.fn();
    shell("/parties", navigate);
    const tabs = screen.getByRole("navigation", { name: "Pestañas abiertas" });
    expect(within(tabs).getByRole("button", { name: "Terceros" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Menú del módulo" })).getByRole("button", { name: "Productos" }));
    expect(navigate).toHaveBeenCalledWith("/products");
  });

  it("closing the active tab navigates to its neighbour", () => {
    const navigate = vi.fn();
    shell("/parties", navigate);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar Terceros" }));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("applies the saved theme and reports a change", () => {
    const onThemeChange = vi.fn();
    shell("/", vi.fn(), { theme: { value: "dark", savedAt: 1 }, onThemeChange });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /Cambiar tema/ }));
    expect(onThemeChange).toHaveBeenCalledWith("auto", expect.any(Number));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("the Asistente button toggles the 400 px drawer, ⌘K text opens it and sends the question with the screen", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/agent/conversation")
        ? new Response(JSON.stringify({ conversationId: null, messages: [], cards: {} }), { status: 200 })
        : new Response('data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n', { status: 200, headers: { "x-conversation-id": "0197a1b2-0000-7000-8000-0000000000c1" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      shell("/");
      expect(screen.getByRole("complementary", { name: "Asistente" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Asistente" }));
      expect(screen.queryByRole("complementary", { name: "Asistente" })).toBeNull();
      fireEvent.click(screen.getByLabelText("Comando"));
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "ventas de la semana por vendedor" } });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      const drawer = screen.getByRole("complementary", { name: "Asistente" });
      await waitFor(() => expect(drawer.textContent).toContain("ventas de la semana por vendedor"));
      const turn = fetcher.mock.calls.find((c) => String(c[0]) === "/api/agent/turn") as unknown as [string, RequestInit];
      expect(JSON.parse(turn[1].body as string)).toEqual({ text: "ventas de la semana por vendedor", screen: { route: "/" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores the server's tabs", () => {
    shell("/", vi.fn(), { initialTabs: { value: { tabs: [{ id: "/products", title: "Productos", href: "/products", kind: "grid" }], activeId: "/products" }, savedAt: 1 } });
    const tabs = screen.getByRole("navigation", { name: "Pestañas abiertas" });
    expect(within(tabs).getByRole("button", { name: "Productos" })).toBeTruthy();
    expect(within(tabs).getByRole("button", { name: "Inicio" }).getAttribute("aria-current")).toBe("page");
  });

  it("a newer browser cache beats an older server copy of the tabs and the theme, and is sent to the server", () => {
    const storage = memoryStorage();
    const products = { id: "/products", title: "Productos", href: "/products", kind: "grid" };
    const categories = { id: "/categories", title: "Categorías", href: "/categories", kind: "grid" };
    storage.setItem(tabsStorageKey("u1"), JSON.stringify({ value: { tabs: [categories], activeId: "home" }, savedAt: 200, companyId: "c1" }));
    storage.setItem("erp.theme.u1", JSON.stringify({ value: "dark", savedAt: 200, companyId: "c1" }));
    const onTabsChange = vi.fn();
    const onThemeChange = vi.fn();
    shell("/", vi.fn(), {
      storage,
      initialTabs: { value: { tabs: [products], activeId: "home" }, savedAt: 100 },
      theme: { value: "light", savedAt: 100 },
      onTabsChange,
      onThemeChange,
    });
    expect(tabNames()).toContain("Categorías");
    expect(tabNames()).not.toContain("Productos");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(onThemeChange).toHaveBeenCalledWith("dark", 200);
    expect(onTabsChange).toHaveBeenCalled();
  });

  it("an older browser cache loses to the server copy", () => {
    const storage = memoryStorage();
    storage.setItem(tabsStorageKey("u1"), JSON.stringify({ value: { tabs: [{ id: "/categories", title: "Categorías", href: "/categories", kind: "grid" }], activeId: "home" }, savedAt: 50, companyId: "c1" }));
    shell("/", vi.fn(), { storage, initialTabs: { value: { tabs: [{ id: "/products", title: "Productos", href: "/products", kind: "grid" }], activeId: "home" }, savedAt: 100 } });
    expect(tabNames()).toContain("Productos");
    expect(tabNames()).not.toContain("Categorías");
  });

  it("switching company starts over from the new company's saved tabs and theme", () => {
    const storage = memoryStorage();
    const view = shell("/", vi.fn(), {
      storage,
      initialTabs: { value: { tabs: [{ id: "/products", title: "Productos", href: "/products", kind: "grid" }], activeId: "home" }, savedAt: 1 },
      theme: { value: "dark", savedAt: 1 },
    });
    expect(tabNames()).toContain("Productos");
    view.rerender(
      shellElement("/", vi.fn(), {
        storage,
        company: otra,
        initialTabs: { value: { tabs: [{ id: "/parties", title: "Terceros", href: "/parties", kind: "grid" }], activeId: "home" }, savedAt: 2 },
        theme: { value: "light", savedAt: 2 },
      }),
    );
    expect(tabNames()).toContain("Terceros");
    expect(tabNames()).not.toContain("Productos");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("the Módulos menu lists modules only, never their items", () => {
    shell("/parties");
    const trigger = screen.getByRole("button", { name: /^Núcleo/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = screen.getByRole("menu");
    const entries = within(menu).getAllByRole("menuitem").map((item) => item.textContent ?? "");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Núcleo");
    expect(entries[0]).toContain("3 opciones");
    for (const item of ["Terceros", "Productos", "Categorías"]) expect(menu.textContent).not.toContain(item);
  });
});
