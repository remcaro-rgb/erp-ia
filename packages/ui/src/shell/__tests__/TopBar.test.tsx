// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { TopBar, type TopBarProps } from "../TopBar";
import type { RecommendationItem } from "../../home/RecommendationCard";
import { renderEs, stubLayoutApis } from "./intl";

// The bell (plan 2B Task 38, design §19a): the caller's open recommendations, the count on the dot and the five newest in the menu, each
// a link to its record (or to Inicio when the record is hidden from the caller or there is none), and «Ver todo en Inicio».

beforeAll(stubLayoutApis);
afterEach(cleanup);

const company = { id: "c1", name: "Café del Norte S.A.S.", taxId: "900373115" };
const base: Omit<TopBarProps, "notifications"> = {
  company,
  companies: [company],
  user: { id: "u1", name: "Laura Martínez", email: "laura@demo.local", roles: ["Facturación"] },
  modules: [{ id: "invoicing", label: "nav.modules.invoicing" }],
  activeModuleId: "invoicing",
  onSelectModule: vi.fn(),
  theme: "light",
  onThemeChange: vi.fn(),
  onOpenPalette: vi.fn(),
  onToggleAssistant: vi.fn(),
};
const raised: RecommendationItem = {
  id: "p1", title: "k", body: "k", agentProfile: "process", suggestedActions: [], source: "process", module: "costing",
  titleKey: "costing.recommendation.cost_missing.title", bodyKey: "costing.recommendation.cost_missing.body",
  params: { product: "Café 500 g", warehouse: null, count: 2 }, href: "/costing/missing",
};
const agent: RecommendationItem = { id: "a1", title: "Revisa tus productos", body: "Algunos no se pueden facturar.", agentProfile: "seed", suggestedActions: [] };
const hidden: RecommendationItem = { ...raised, id: "p2", href: null, titleKey: "invoicing.recommendation.auto_skipped.title", bodyKey: "invoicing.recommendation.auto_skipped.body", module: "invoicing", params: { document: null } };

const open = () => fireEvent.keyDown(screen.getByRole("button", { name: "Notificaciones" }), { key: "Enter" });

describe("TopBar notifications", () => {
  it("shows the open count on the bell", () => {
    renderEs(<TopBar {...base} notifications={{ total: 12, items: [raised] }} />);
    expect(screen.getByRole("button", { name: "Notificaciones" }).textContent).toBe("9+");
  });

  it("lists the items with their composed text; each opens its record, or Inicio; «Ver todo en Inicio» opens Inicio", () => {
    const onOpen = vi.fn();
    renderEs(<TopBar {...base} notifications={{ total: 3, items: [raised, agent, hidden] }} onOpenNotification={onOpen} />);
    open();
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Falta el costo de un producto"),
      expect.stringContaining("Revisa tus productos"),
      expect.stringContaining("No se creó la factura automática"),
      "Ver todo en Inicio",
    ]);
    expect(items[0]!.textContent).toContain("Café 500 g se movió en — sin costo conocido (2 movimientos)");
    fireEvent.click(items[0]!);
    expect(onOpen).toHaveBeenLastCalledWith("/costing/missing");
    open();
    fireEvent.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[2]!);
    expect(onOpen).toHaveBeenLastCalledWith("/");
    open();
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Ver todo en Inicio" }));
    expect(onOpen).toHaveBeenLastCalledWith("/");
  });

  it("says there is nothing new when the caller has no open recommendation", () => {
    renderEs(<TopBar {...base} notifications={{ total: 0, items: [] }} />);
    expect(screen.getByRole("button", { name: "Notificaciones" }).textContent).toBe("");
    open();
    expect(within(screen.getByRole("menu")).getByText("Sin novedades")).toBeTruthy();
  });
});
