// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { messages } from "@erp/i18n";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppShell } from "../AppShell";
import { GridCell } from "../../grid/GridCell";
import type { NavItem } from "../types";
import { tabsStorageKey } from "../tabs-store";
import { RecordForm } from "../../forms/form-parts";
import { assistantOpenStorageKey, dianHintsStorageKey, readCachedPref, sideMenuStorageKey, writeCachedPref } from "../prefs-cache";
import { memoryStorage, renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
// jsdom's window is 1024 px wide; the drawer starts closed below 1280 px (OD-10), so tests that need it open use a laptop-plus width.
const setWidth = (width: number) => {
  window.innerWidth = width;
};
beforeEach(() => setWidth(1440));
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
    const items = within(screen.getByRole("navigation", { name: "Menú del módulo" })).getAllByRole("link");
    expect(items.map((b) => b.textContent)).toEqual(["Inicio", "Terceros", "Productos", "Categorías"]);
    expect(items[1]!.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("LM")).toBeTruthy();
  });

  it("⌘K lists the children of a navigation group, never the group", () => {
    const grouped: NavItem[] = [
      { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" },
      { id: "core.masters", label: "nav.core.products", href: "#", icon: "list", children: [{ id: "core.categories", label: "nav.core.categories", href: "/categories", icon: "tags" }] },
    ];
    shell("/", vi.fn(), { nav: grouped });
    fireEvent.click(screen.getByLabelText("Comando"));
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((o) => o.includes("Categorías"))).toBe(true);
    expect(options.some((o) => o.includes("Productos"))).toBe(false);
  });

  // Entity types spec 2026-11-02 §2.4, §9.2 (Task 10): every module's level-1 items are Maestros, Documentos, Reportes and Parámetros.
  describe("menu sections", () => {
    const section = (name: string, children: NavItem[]): NavItem => ({ id: `core.${name}`, label: `nav.section.${name}`, href: "#", icon: "list", section: name as NavItem["section"], children });
    const sectioned: NavItem[] = [
      section("maestros", [{ id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" }]),
      section("documentos", []),
      section("reportes", []),
      section("parametros", [{ id: "core.posting", label: "nav.accounting.posting", href: "/posting", icon: "list", badge: 2 }]),
    ];

    it("shows the four sections as the module's items, in order", () => {
      shell("/parties", vi.fn(), { nav: sectioned });
      const bar = screen.getByRole("navigation", { name: "Menú del módulo" });
      expect(within(bar).getAllByRole("button", { expanded: false }).map((b) => b.textContent)).toEqual(["Maestros", "Documentos", "Reportes", "Parámetros 2"]);
      expect(within(bar).getByRole("button", { name: /^Maestros/ }).getAttribute("aria-current")).toBe("page");
    });

    it("an empty section opens on its empty state instead of disappearing", () => {
      shell("/parties", vi.fn(), { nav: sectioned });
      fireEvent.click(within(screen.getByRole("navigation", { name: "Menú del módulo" })).getByRole("button", { name: /^Documentos/ }));
      const menu = screen.getByRole("menu", { name: "Documentos" });
      expect(within(menu).queryAllByRole("menuitem")).toEqual([]);
      expect(within(menu).getByText("Aún no hay elementos en esta sección")).toBeTruthy();
    });

    it("a section entry carries its badge, and the section shows how many are waiting", () => {
      const navigate = vi.fn();
      shell("/parties", navigate, { nav: sectioned });
      const trigger = within(screen.getByRole("navigation", { name: "Menú del módulo" })).getByRole("button", { name: /^Parámetros/ });
      expect(within(trigger).getByLabelText("2 pendientes")).toBeTruthy();
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("menuitem", { name: "Reglas contables 2 pendientes" }));
      expect(navigate).toHaveBeenCalledWith("/posting");
    });
  });

  it("the page being shown opens its tab, and a module item navigates", () => {
    const navigate = vi.fn();
    shell("/parties", navigate);
    const tabs = screen.getByRole("navigation", { name: "Pestañas abiertas" });
    expect(within(tabs).getByRole("button", { name: "Terceros" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Menú del módulo" })).getByRole("link", { name: "Productos" }));
    expect(navigate).toHaveBeenCalledWith("/products");
  });

  it("a report page opens a tab named by the report, with or without parameters, never the generic menu item", () => {
    const { unmount } = shell("/accounting/reports/trial_balance");
    expect(tabNames()).toContain("Balance de prueba");
    unmount();
    shell("/accounting/reports/balance_sheet?p=%7B%7D");
    expect(tabNames()).toContain("Estado de situación financiera");
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

  it("gives the grids below it the company's time zone", () => {
    const column = { field: "at", label: "A", type: "datetime", kind: "date" as const, mode: "visible" as const, filterable: true, sortable: true };
    renderEs(
      <AppShell company={{ ...cafe, timeZone: "Asia/Tokyo" }} companies={[cafe]} user={{ id: "u1", name: "L", email: "l@x.co", roles: [] }} modules={[{ id: "core", label: "nav.modules.core" }]} nav={nav} currentHref="/" navigate={vi.fn()} storage={memoryStorage()}>
        <table>
          <tbody>
            <tr>
              <GridCell column={column} row={{ id: "1", at: "2026-10-28T03:30:00Z" }} />
            </tr>
          </tbody>
        </table>
      </AppShell>,
    );
    expect(screen.getByText(/^2026\/10\/28 12:30/)).toBeTruthy();
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

  // Shell v7 (owner 2026-11-02, design §22.24, rule 19): the left side menu lists module names only; the active module's sections sit in the bar.
  describe("shell v7 side menu", () => {
    const twoModules = [{ id: "core", label: "nav.modules.core" }, { id: "kernel", label: "nav.modules.kernel" }];
    const adminNav: NavItem[] = [...nav, { id: "kernel.admin_users", label: "nav.kernel.users", href: "/admin/users", icon: "users" }];
    const side = () => screen.getByRole("navigation", { name: "Módulos" });

    it("lists the module names only, never their items, the active one marked", () => {
      shell("/parties", vi.fn(), { modules: twoModules, nav: adminNav });
      expect(screen.getByRole("complementary", { name: "Menú de módulos" })).toBeTruthy();
      const entries = within(side()).getAllByRole("button");
      expect(entries.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Núcleo", "Sistema"]);
      expect(within(side()).queryAllByRole("link")).toEqual([]);
      for (const item of ["Terceros", "Productos", "Usuarios"]) expect(side().textContent).not.toContain(item);
      expect(entries[0]!.getAttribute("aria-current")).toBe("true");
      expect(screen.getByRole("button", { name: "Contraer menú" }).getAttribute("aria-controls")).toBe(side().id);
    });

    it("the server render states no expanded state before the viewport is known", () => {
      const html = renderToString(
        <NextIntlClientProvider locale="es-419" messages={messages("es-419")} timeZone="America/Bogota">
          {shellElement("/parties")}
        </NextIntlClientProvider>,
      );
      const toggle = /<button[^>]*aria-controls="erp-side-nav"[^>]*>/.exec(html)?.[0] ?? "";
      expect(toggle).not.toBe("");
      expect(toggle).not.toContain("aria-expanded");
      expect(toggle).toContain('aria-label="Contraer o expandir menú"');
    });

    it("a module the caller has no item in (menu access, permissions) is not listed", () => {
      shell("/parties", vi.fn(), { modules: twoModules, nav });
      expect(within(side()).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Núcleo"]);
    });

    it("picking a module shows its sections in the bar and brings its open tab to the front", async () => {
      const navigate = vi.fn();
      const initialTabs = { value: { tabs: [{ id: "/admin/users", title: "Usuarios", href: "/admin/users", kind: "grid" as const }], activeId: "/admin/users" }, savedAt: 1 };
      shell("/parties", navigate, { modules: twoModules, nav: adminNav, initialTabs });
      fireEvent.click(within(side()).getByRole("button", { name: "Sistema" }));
      expect(within(side()).getByRole("button", { name: "Sistema" }).getAttribute("aria-current")).toBe("true");
      expect(within(screen.getByRole("navigation", { name: "Menú del módulo" })).getByRole("link", { name: "Usuarios" })).toBeTruthy();
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/admin/users"));
    });

    it("picking a module with no open tab opens its first option", () => {
      const navigate = vi.fn();
      shell("/parties", navigate, { modules: twoModules, nav: adminNav });
      fireEvent.click(within(side()).getByRole("button", { name: "Sistema" }));
      expect(navigate).toHaveBeenCalledWith("/admin/users");
    });

    it("the module's sections render in the bar with the empty state", () => {
      const sectioned: NavItem[] = [
        { id: "core.maestros", label: "nav.section.maestros", href: "#", icon: "list", section: "maestros", children: [nav[0]!] },
        { id: "core.documentos", label: "nav.section.documentos", href: "#", icon: "list", section: "documentos", children: [] },
      ];
      shell("/parties", vi.fn(), { nav: sectioned });
      const bar = screen.getByRole("navigation", { name: "Menú del módulo" });
      expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Maestros", "Documentos"]);
      expect(side().textContent).not.toContain("Maestros");
    });

    it("collapses to the icon rail and back, remembered per viewer", () => {
      const storage = memoryStorage();
      shell("/parties", vi.fn(), { storage });
      const rail = screen.getByRole("complementary", { name: "Menú de módulos" });
      const toggle = screen.getByRole("button", { name: "Contraer menú" });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Expandir menú" }).getAttribute("aria-expanded")).toBe("false");
      expect(rail.getAttribute("data-collapsed")).toBe("true");
      expect(readCachedPref(storage, sideMenuStorageKey("u1"), "c1")?.value).toBe(true);
      cleanup();
      shell("/parties", vi.fn(), { storage });
      expect(screen.getByRole("button", { name: "Expandir menú" }).getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(screen.getByRole("button", { name: "Expandir menú" }));
      expect(screen.getByRole("button", { name: "Contraer menú" }).getAttribute("aria-expanded")).toBe("true");
      expect(readCachedPref(storage, sideMenuStorageKey("u1"), "c1")?.value).toBe(false);
    });

    it("starts collapsed below 1440 px when nothing is saved; a saved choice wins", () => {
      setWidth(1280);
      const storage = memoryStorage();
      shell("/parties", vi.fn(), { storage });
      expect(screen.getByRole("button", { name: "Expandir menú" }).getAttribute("aria-expanded")).toBe("false");
      cleanup();
      writeCachedPref(storage, sideMenuStorageKey("u1"), "c1", { value: false, savedAt: 1 });
      shell("/parties", vi.fn(), { storage });
      expect(screen.getByRole("button", { name: "Contraer menú" }).getAttribute("aria-expanded")).toBe("true");
    });

    it("a refused storage never breaks the menu", () => {
      const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
      shell("/parties", vi.fn(), { storage: broken });
      fireEvent.click(screen.getByRole("button", { name: "Contraer menú" }));
      expect(screen.getByRole("button", { name: "Expandir menú" })).toBeTruthy();
    });
  });

  // UI density audit quick win 13 (M13) and 16 (L1)
  it("offers a skip link to the page, which takes the caret without a ring", () => {
    shell("/parties");
    const skip = screen.getByRole("link", { name: "Saltar al contenido" });
    expect(skip.getAttribute("href")).toBe("#erp-main");
    const main = screen.getByRole("main");
    expect(main.id).toBe("erp-main");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("the Asistente toggle says whether the drawer is open and Ctrl+/ or ⌘/ toggles it", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ conversationId: null, messages: [], cards: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      shell("/");
      const toggle = screen.getByRole("button", { name: "Asistente" });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-controls")).toBe("erp-assistant");
      expect(toggle.getAttribute("aria-keyshortcuts")).toBe("Control+/ Meta+/");
      expect(toggle.getAttribute("title")).toBe("Mostrar u ocultar el asistente (Ctrl+/ o ⌘/)");
      expect(screen.getByRole("complementary", { name: "Asistente" }).id).toBe("erp-assistant");

      fireEvent.keyDown(document, { key: "/", ctrlKey: true });
      expect(screen.queryByRole("complementary", { name: "Asistente" })).toBeNull();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(screen.getByRole("main"));

      fireEvent.keyDown(document, { key: "/", metaKey: true });
      expect(screen.getByRole("complementary", { name: "Asistente" })).toBeTruthy();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await waitFor(() => expect(document.activeElement?.id).toBe("erp-assistant-input"));

      fireEvent.keyDown(document, { key: "/" });
      expect(screen.getByRole("complementary", { name: "Asistente" })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("draws the notification dot only when there is something to read", () => {
    shell("/");
    const bell = screen.getByRole("button", { name: "Notificaciones" });
    expect(bell.querySelector("span")).toBeNull();
  });

  // Branch review fix 7: Ctrl+Alt+/ (AltGr layouts) and a key pressed in an open dialog are not the assistant toggle.
  it("ignores Ctrl+/ with Alt, and while a dialog (the palette) is open", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ conversationId: null, messages: [], cards: {} }), { status: 200 })));
    try {
      shell("/");
      fireEvent.keyDown(document, { key: "/", ctrlKey: true, altKey: true });
      expect(screen.getByRole("complementary", { name: "Asistente" })).toBeTruthy();
      fireEvent.click(screen.getByLabelText("Comando"));
      expect(screen.getByRole("dialog")).toBeTruthy();
      fireEvent.keyDown(document, { key: "/", ctrlKey: true });
      // (The open dialog hides the page from the accessibility tree.)
      expect(screen.getByRole("button", { name: "Asistente", hidden: true }).getAttribute("aria-expanded")).toBe("true");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Phase 1b task 1 (OD-10): the drawer starts closed below 1280 px, evaluated once on first mount; a stored
// `assistant.open` preference (server copy or this browser's newer cache) always wins; only a user's toggle is saved.
describe("AppShell, the assistant drawer's default (OD-10)", () => {
  const drawer = () => document.getElementById("erp-assistant")!;
  const fetchStub = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ conversationId: null, messages: [], cards: {} }), { status: 200 })));
  afterEach(() => vi.unstubAllGlobals());

  it("is closed at 1200 px and open at 1400 px", () => {
    fetchStub();
    setWidth(1200);
    shell("/");
    expect(drawer().hidden).toBe(true);
    expect(screen.getByRole("button", { name: "Asistente" }).getAttribute("aria-expanded")).toBe("false");
    cleanup();
    setWidth(1400);
    shell("/");
    expect(drawer().hidden).toBe(false);
    cleanup();
    setWidth(1280);
    shell("/");
    expect(drawer().hidden).toBe(false);
  });

  it("a stored preference wins over the width, both ways", () => {
    fetchStub();
    setWidth(1200);
    shell("/", vi.fn(), { assistantOpen: { value: true, savedAt: 1 } });
    expect(drawer().hidden).toBe(false);
    cleanup();
    setWidth(1600);
    shell("/", vi.fn(), { assistantOpen: { value: false, savedAt: 1 } });
    expect(drawer().hidden).toBe(true);
  });

  it("this browser's cache wins over the server's copy when it is newer", () => {
    fetchStub();
    setWidth(1600);
    const storage = memoryStorage();
    writeCachedPref(storage, assistantOpenStorageKey("u1"), "c1", { value: false, savedAt: 50 });
    shell("/", vi.fn(), { assistantOpen: { value: true, savedAt: 10 }, storage });
    expect(drawer().hidden).toBe(true);
  });

  it("is evaluated once: a later resize does not move it", () => {
    fetchStub();
    setWidth(1440);
    shell("/");
    setWidth(1000);
    fireEvent(window, new Event("resize"));
    expect(drawer().hidden).toBe(false);
  });

  it("saves a user's toggle (button and Ctrl+/) with its time and caches it, but not the default", () => {
    fetchStub();
    setWidth(1200);
    const onAssistantOpenChange = vi.fn();
    const storage = memoryStorage();
    shell("/", vi.fn(), { onAssistantOpenChange, storage });
    expect(onAssistantOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Asistente" }));
    expect(drawer().hidden).toBe(false);
    expect(onAssistantOpenChange).toHaveBeenLastCalledWith(true, expect.any(Number));
    expect(readCachedPref(storage, assistantOpenStorageKey("u1"), "c1")?.value).toBe(true);
    fireEvent.keyDown(document, { key: "/", ctrlKey: true });
    expect(drawer().hidden).toBe(true);
    expect(onAssistantOpenChange).toHaveBeenLastCalledWith(false, expect.any(Number));
    expect(readCachedPref(storage, assistantOpenStorageKey("u1"), "c1")?.value).toBe(false);
  });

  it("⌘K asking the assistant opens it without saving a preference", () => {
    fetchStub();
    setWidth(1200);
    const onAssistantOpenChange = vi.fn();
    shell("/", vi.fn(), { onAssistantOpenChange });
    fireEvent.click(screen.getByLabelText("Comando"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ventas de hoy" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(drawer().hidden).toBe(false);
    expect(onAssistantOpenChange).not.toHaveBeenCalled();
  });
});

// Phase 1b task 1 (OD-1): grid and admin routes use the tighter page padding; home and the record page keep v5's.
describe("AppShell, the page padding (OD-1)", () => {
  const main = () => screen.getByRole("main");

  it.each(["/parties", "/admin/permissions", "/products"])("%s is dense", (href) => {
    shell(href);
    expect(main().getAttribute("data-density")).toBe("tight");
    expect(main().className).toContain("erp-main");
  });

  it.each(["/", "/r/core.party/0197a1b2-0000-7000-8000-0000000000c1"])("%s keeps the v5 spacing", (href) => {
    shell(href);
    expect(main().hasAttribute("data-density")).toBe(false);
    expect(main().className).toContain("erp-main");
  });
});

// Review fix: with no saved choice the drawer is decided by CSS first (`data-assistant="auto"`), so a laptop never sees it
// open and then collapse; the client then resolves the explicit state to what the CSS already shows.
describe("AppShell, the drawer's unset state is CSS-first", () => {
  const drawer = () => document.getElementById("erp-assistant")!;
  const ssr = (extra: Partial<ShellProps> = {}) =>
    renderToString(
      <NextIntlClientProvider locale="es-419" messages={messages("es-419")} timeZone="America/Bogota">
        {shellElement("/", vi.fn(), { storage: null, ...extra })}
      </NextIntlClientProvider>,
    );

  it("the server markup carries the auto state, not hidden, when no choice is saved", () => {
    const html = ssr();
    expect(html).toMatch(/<aside id="erp-assistant"[^>]*data-assistant="auto"/);
    expect(html).not.toMatch(/<aside id="erp-assistant"[^>]*hidden/);
  });

  it("a saved choice renders explicitly: no auto state, hidden when closed", () => {
    expect(ssr({ assistantOpen: { value: false, savedAt: 1 } })).toMatch(/<aside id="erp-assistant"[^>]*hidden=""(?![^>]*data-assistant)|<aside id="erp-assistant"(?![^>]*data-assistant)[^>]*hidden/);
    expect(ssr({ assistantOpen: { value: true, savedAt: 1 } })).not.toMatch(/data-assistant="auto"/);
  });

  it("after mounting the auto state is resolved and, when the media state already matches, the drawer is never toggled", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ conversationId: null, messages: [], cards: {} }), { status: 200 })));
    const toggles: string[] = [];
    const observer = new MutationObserver((records) => records.forEach((r) => toggles.push(`${(r.target as Element).id}:${r.attributeName}`)));
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
    setWidth(1440);
    shell("/");
    expect(drawer().hasAttribute("data-assistant")).toBe(false);
    expect(drawer().hidden).toBe(false);
    expect(toggles.filter((t) => t.startsWith("erp-assistant"))).toEqual([]);
    observer.disconnect();
    cleanup();
    setWidth(1200);
    shell("/");
    expect(drawer().hasAttribute("data-assistant")).toBe(false);
    expect(drawer().hidden).toBe(true);
  });
});

// "Ver códigos DIAN" (OD-12) is a saved preference the shell hands to every record form below it: the server's copy
// renders on the first paint (no flash), a newer copy of this browser wins, and a change is cached and reported.
describe("AppShell, the DIAN hints preference", () => {
  const withForm = (extra: Partial<ShellProps> = {}) => (
    <AppShell company={cafe} companies={[cafe]} user={{ id: "u1", name: "L", email: "l@x.co", roles: [] }} modules={[{ id: "core", label: "nav.modules.core" }]} nav={nav} currentHref="/r/core.party/1" navigate={vi.fn()} storage={memoryStorage()} {...extra}>
      <RecordForm canSave onSave={() => {}} failure={null}>
        <input aria-label="campo" />
      </RecordForm>
    </AppShell>
  );
  const dianSwitch = () => screen.getByRole("switch", { name: "Ver códigos DIAN" });

  it("is off when nothing was saved, and on from the first server markup when the saved choice is on", () => {
    const ssr = (extra: Partial<ShellProps> = {}) =>
      renderToString(
        <NextIntlClientProvider locale="es-419" messages={messages("es-419")} timeZone="America/Bogota">
          {withForm({ storage: null, ...extra })}
        </NextIntlClientProvider>,
      );
    expect(ssr()).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
    expect(ssr({ dianHints: { value: true, savedAt: 1 } })).toMatch(/role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
  });

  it("a change turns the forms' hints on, is cached for this browser and is reported with its time", () => {
    const storage = memoryStorage();
    const onDianHintsChange = vi.fn();
    renderEs(withForm({ storage, onDianHintsChange }));
    expect(dianSwitch().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(dianSwitch());
    expect(dianSwitch().getAttribute("aria-checked")).toBe("true");
    expect(onDianHintsChange).toHaveBeenCalledWith(true, expect.any(Number));
    expect(readCachedPref(storage, dianHintsStorageKey("u1"), "c1")?.value).toBe(true);
  });

  it("a newer copy in this browser's cache wins over the server's", () => {
    const storage = memoryStorage();
    writeCachedPref(storage, dianHintsStorageKey("u1"), "c1", { value: true, savedAt: 50 });
    renderEs(withForm({ storage, dianHints: { value: false, savedAt: 10 } }));
    expect(dianSwitch().getAttribute("aria-checked")).toBe("true");
  });
});

describe("AppShell, module context and tab titles (T7)", () => {
  const accountingNav: NavItem[] = [
    { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" },
    { id: "accounting.entries", label: "nav.accounting.entries", href: "/accounting/entries", icon: "book-open" },
    { id: "accounting.reports", label: "nav.accounting.reports", href: "/accounting/reports", icon: "file-bar-chart" },
  ];
  const modules = [
    { id: "core", label: "nav.modules.core" },
    { id: "accounting", label: "nav.modules.accounting" },
  ];
  const moduleNames = () => within(screen.getByRole("navigation", { name: "Menú del módulo" })).getAllByRole("link").map((b) => b.textContent);

  it("a record page keeps the module of its entity: /r/accounting.entry/<id> shows Contabilidad", () => {
    shell("/r/accounting.entry/0198-x", vi.fn(), { nav: accountingNav, modules });
    expect(moduleNames()).toEqual(["Comprobantes", "Informes"]);
  });

  it("a record's tab is named after its entity, not Registro; a path with no menu item is not shown raw", () => {
    shell("/r/accounting.entry/0198-x", vi.fn(), { nav: accountingNav, modules });
    expect(tabNames()).toContain("Comprobante");
    cleanup();
    shell("/accounting/setup", vi.fn(), { nav: accountingNav, modules });
    expect(tabNames()).toContain("Configurar contabilidad");
    cleanup();
    shell("/accounting/reports/trial-balance", vi.fn(), { nav: accountingNav, modules });
    expect(tabNames()).toContain("Informes");
  });

  it("a tab whose page redirects is replaced by the page it lands on, not kept beside it", () => {
    const saved = { value: { tabs: [{ id: "home", title: "Inicio", href: "/", kind: "home", pinned: true }, { id: "/accounting/setup", title: "Configurar contabilidad", href: "/accounting/setup", kind: "grid" }], activeId: "home" }, savedAt: 1 };
    const navigate = vi.fn();
    const view = shell("/", navigate, { nav: accountingNav, modules, initialTabs: saved });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Pestañas abiertas" })).getByRole("button", { name: "Configurar contabilidad" }));
    expect(navigate).toHaveBeenCalledWith("/accounting/setup");
    // The server redirected: the shell now shows /accounting/entries.
    view.rerender(shellElement("/accounting/entries", navigate, { nav: accountingNav, modules, initialTabs: saved }));
    expect(tabNames()).toEqual(["Inicio", "Comprobantes"]);
  });
});

describe("AppShell, ⌘K identities (T2)", () => {
  it("an item listed twice in the navigation appears once in the palette", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dup: NavItem[] = [...nav, nav[0]!];
    shell("/", vi.fn(), { nav: dup });
    fireEvent.click(screen.getByLabelText("Comando"));
    const labels = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(labels.filter((l) => l.includes("Terceros"))).toHaveLength(1);
    spy.mockRestore();
  });

  it("ordinary navigation accumulates tabs: /parties then /products then /categories leaves all open", () => {
    const view = shell("/parties");
    view.rerender(shellElement("/products"));
    view.rerender(shellElement("/categories"));
    expect(tabNames()).toEqual(["Inicio", "Terceros", "Productos", "Categorías"]);
  });
});

describe("AppShell · saved tabs", () => {
  it("a tab saved with the generic 'Informes' title takes the report's name; a drill-down title stays", () => {
    const saved = {
      value: {
        tabs: [
          { id: "home", href: "/", title: "home", kind: "home", pinned: true },
          { id: "/accounting/reports/account_detail", href: "/accounting/reports/account_detail", title: "Informes", kind: "report" },
          { id: "/accounting/reports/account_detail?p=1", href: "/accounting/reports/account_detail?p=1", title: "1110 · Bancos · noviembre de 2026", kind: "report" },
        ],
        activeId: "home",
      },
      savedAt: 1,
    };
    const items = [{ id: "accounting.reports", label: "nav.accounting.reports", href: "/accounting/reports", icon: "file-bar-chart" }];
    shell("/", vi.fn(), { initialTabs: saved, nav: items });
    expect(tabNames()).toEqual(expect.arrayContaining(["Auxiliar por cuenta", "1110 · Bancos · noviembre de 2026"]));
    expect(tabNames()).not.toContain("Informes");
  });
});

describe("AppShell · pages opened with parameters", () => {
  it("does not open a second, bare tab for the page of the active tab that has a query", () => {
    const href = "/accounting/reports/account_detail?p=%7B%7D";
    const saved = {
      value: {
        tabs: [
          { id: "home", href: "/", title: "home", kind: "home", pinned: true },
          { id: href, href, title: "6135 · Comercio · 2026/01/01 – 2026/11/30", kind: "report" },
        ],
        activeId: href,
      },
      savedAt: 1,
    };
    shell("/accounting/reports/account_detail", vi.fn(), { initialTabs: saved });
    expect(tabNames()).toEqual(["Inicio", "6135 · Comercio · 2026/01/01 – 2026/11/30"]);
  });
});
