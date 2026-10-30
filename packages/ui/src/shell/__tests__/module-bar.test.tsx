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

function setup(activeHref: string) {
  const onNavigate = vi.fn();
  render(
    <NextIntlClientProvider locale="es-419" messages={{ ...messages("es-419"), ...copy }} timeZone="America/Bogota">
      <ModuleBar items={items} showHome={false} activeHref={activeHref} onNavigate={onNavigate} />
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
    expect(screen.getByRole("button", { name: "Comprobantes" }).getAttribute("aria-current")).toBeNull();

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
