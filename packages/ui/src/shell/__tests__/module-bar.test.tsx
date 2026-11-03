// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { messages } from "@erp/i18n";
import { ModuleBar } from "../ModuleBar";
import type { NavItem } from "../types";

afterEach(cleanup);

const LEAVES = ["accounts", "cost_centers", "open_auxiliaries", "items", "business_units", "journals"];
const copy = {
  tst: {
    vouchers: "Comprobantes",
    masters: "Maestros",
    accounts: "Plan de cuentas",
    cost_centers: "Centros de costo",
    open_auxiliaries: "Auxiliares abiertos",
    items: "Ítems",
    business_units: "Unidades de negocio",
    journals: "Fuentes",
  },
};
const leaf = (name: string): NavItem => ({ id: `acc.${name}`, label: `tst.${name}`, href: `/accounting/${name.replaceAll("_", "-")}`, icon: "list" });
const items: NavItem[] = [
  { id: "acc.vouchers", label: "tst.vouchers", href: "/accounting/vouchers", icon: "file" },
  { id: "acc.masters", label: "tst.masters", href: "#", icon: "list", children: LEAVES.map(leaf) },
];

function setup(activeHref: string, bar: NavItem[] = items) {
  const onNavigate = vi.fn();
  render(
    <NextIntlClientProvider locale="es-419" messages={{ ...messages("es-419"), ...copy }} timeZone="America/Bogota">
      <ModuleBar items={bar} showHome={false} activeHref={activeHref} onNavigate={onNavigate} />
    </NextIntlClientProvider>,
  );
  return { onNavigate };
}

describe("module-bar groups", () => {
  it("renders a group as a dropdown that is active when a child route is active", () => {
    setup("/accounting/accounts");
    const group = screen.getByRole("button", { name: "Maestros" });
    expect(group.getAttribute("aria-current")).toBe("page");
    expect(group.getAttribute("aria-haspopup")).toBe("menu");
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    // A plain item next to it is not active.
    expect(screen.getByRole("link", { name: "Comprobantes" }).getAttribute("aria-current")).toBeNull();

    fireEvent.click(group);
    const menu = screen.getByRole("menu");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Plan de cuentas", "Centros de costo", "Auxiliares abiertos", "Ítems", "Unidades de negocio", "Fuentes"]);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(group);
  });

  it("is not active on another route, moves with the arrow keys and navigates from a child", () => {
    const { onNavigate } = setup("/accounting/vouchers");
    const group = screen.getByRole("button", { name: "Maestros" });
    expect(group.getAttribute("aria-current")).toBeNull();

    fireEvent.click(group);
    const menu = screen.getByRole("menu");
    const entries = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(entries[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(entries[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(entries[5]);

    fireEvent.click(entries[1]!);
    expect(onNavigate).toHaveBeenCalledWith({ href: "/accounting/cost-centers", title: "Centros de costo", kind: "grid" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("module-bar links and overflow (UX-OD-1, T5)", () => {
  it("items are links: a plain click moves inside the shell, ⌘/Ctrl and the middle button are the browser's", () => {
    const { onNavigate } = setup("/accounting/accounts");
    const link = screen.getByRole("link", { name: "Comprobantes" });
    expect(link.getAttribute("href")).toBe("/accounting/vouchers");
    expect(fireEvent.click(link)).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith({ href: "/accounting/vouchers", title: "Comprobantes", kind: "grid" });
    onNavigate.mockClear();
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("what does not fit moves into a trailing Más menu, in order, with a group's entries expanded", () => {
    const widths: Record<string, number> = { Comprobantes: 120, Maestros: 100, Más: 60 };
    const offset = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return widths[this.textContent?.trim() ?? ""] ?? 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "NAV" ? 200 : 0;
    });
    try {
      // 120 (Comprobantes) + 100 (Maestros) + 60 (Más) > 200: only Comprobantes stays in the bar.
      setup("/accounting/vouchers");
      expect(screen.getByRole("link", { name: "Comprobantes" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Maestros" })).toBeNull();
      const more = screen.getByRole("button", { name: /Más/ });
      fireEvent.click(more);
      const entries = within(screen.getByRole("menu")).getAllByRole("menuitem").map((b) => b.textContent);
      expect(entries).toEqual(["Plan de cuentas", "Centros de costo", "Auxiliares abiertos", "Ítems", "Unidades de negocio", "Fuentes"]);
    } finally {
      offset.mockRestore();
      client.mockRestore();
    }
  });

  it("an empty menu section moved into Más shows its name and the empty state instead of vanishing (spec §9.2, m6)", () => {
    const widths: Record<string, number> = { Comprobantes: 120, Maestros: 100, Documentos: 100, Más: 60 };
    const offset = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return widths[this.textContent?.trim() ?? ""] ?? 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "NAV" ? 200 : 0;
    });
    try {
      const documentos: NavItem = { id: "acc.documentos", label: "nav.section.documentos", href: "#", icon: "file", section: "documentos", children: [] };
      setup("/accounting/vouchers", [...items, documentos]);
      fireEvent.click(screen.getByRole("button", { name: /Más/ }));
      const menu = screen.getByRole("menu");
      expect(within(menu).getAllByRole("menuitem")).toHaveLength(LEAVES.length);
      const section = within(menu).getByRole("group", { name: "Documentos" });
      expect(within(section).getByText("Documentos")).toBeTruthy();
      expect(within(section).getByText("Aún no hay elementos en esta sección")).toBeTruthy();
      // In the bar's order: Maestros' entries, then Documentos.
      expect(menu.lastElementChild).toBe(section);
    } finally {
      offset.mockRestore();
      client.mockRestore();
    }
  });

  it("when everything fits there is no Más", () => {
    setup("/accounting/vouchers");
    expect(screen.queryByRole("button", { name: /Más/ })).toBeNull();
  });
});
