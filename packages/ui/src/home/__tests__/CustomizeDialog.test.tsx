// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { CustomizeDialog, type CustomizeItem } from "../CustomizeDialog";
import { renderEs } from "../../shell/__tests__/intl";

afterEach(cleanup);

const items: CustomizeItem[] = [
  { id: "accounting.result_month", kind: "kpi", module: "accounting", label: "home.catalog.accounting_result_month.label", description: "home.catalog.accounting_result_month.description" },
  { id: "accounting.open_periods", kind: "kpi", module: "accounting", label: "home.catalog.accounting_open_periods.label", description: "home.catalog.accounting_open_periods.description" },
  { id: "accounting.top_expenses", kind: "chart", module: "accounting", label: "home.catalog.accounting_top_expenses.label", description: "home.catalog.accounting_top_expenses.description" },
];

function mount(hidden: string[] = [], onChange = vi.fn(), extra: Partial<Parameters<typeof CustomizeDialog>[0]> = {}) {
  renderEs(<CustomizeDialog open onOpenChange={vi.fn()} items={items} hidden={hidden} onChange={onChange} {...extra} />);
  return onChange;
}

describe("CustomizeDialog (Personalizar página de inicio)", () => {
  it("lists every indicator and chart with its short description and an on/off switch, indicators first", () => {
    mount();
    const dialog = screen.getByRole("dialog", { name: "Personalizar página de inicio" });
    expect(within(dialog).getByRole("heading", { name: "Indicadores" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Gráficos" })).toBeTruthy();
    expect(within(dialog).getByText("Utilidad o pérdida del período en curso según el estado de resultados.")).toBeTruthy();
    expect(within(dialog).getByText("Las cinco cuentas con más gasto en el período en curso.")).toBeTruthy();
    const switches = within(dialog).getAllByRole("switch");
    expect(switches.map((s) => s.getAttribute("aria-label"))).toEqual(["Mostrar Resultado del mes", "Mostrar Períodos abiertos", "Mostrar Principales gastos del mes"]);
    expect(switches.every((s) => s.getAttribute("aria-checked") === "true")).toBe(true);
    expect(within(dialog).getByText("3 de 3 activos")).toBeTruthy();
  });

  it("switching an item off hands back the list of switched-off ids; switching it on takes it out", () => {
    const onChange = mount();
    fireEvent.click(screen.getByRole("switch", { name: "Mostrar Principales gastos del mes" }));
    expect(onChange).toHaveBeenCalledWith(["accounting.top_expenses"]);
    cleanup();
    const again = mount(["accounting.open_periods", "accounting.top_expenses"]);
    expect(screen.getByRole("switch", { name: "Mostrar Períodos abiertos" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Mostrar Períodos abiertos" }));
    expect(again).toHaveBeenCalledWith(["accounting.top_expenses"]);
  });

  it("Activar todo and Desactivar todo set the whole list at once", () => {
    const onChange = mount(["accounting.result_month"]);
    fireEvent.click(screen.getByRole("button", { name: "Activar todo" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole("button", { name: "Desactivar todo" }));
    expect(onChange).toHaveBeenLastCalledWith(["accounting.open_periods", "accounting.result_month", "accounting.top_expenses"]);
  });

  it("groups the items by module when the page spans several", () => {
    renderEs(
      <CustomizeDialog
        open
        onOpenChange={vi.fn()}
        hidden={[]}
        onChange={vi.fn()}
        items={[...items.slice(0, 1), { id: "support.tickets", kind: "kpi", module: "support", label: "home.catalog.support_tickets.label", description: "home.catalog.support_tickets.description" }]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Contabilidad" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Soporte" })).toBeTruthy();
  });

  it("says so when the caller has nothing to customize, and when the last save failed", () => {
    renderEs(<CustomizeDialog open onOpenChange={vi.fn()} items={[]} hidden={[]} onChange={vi.fn()} error />);
    expect(screen.getByText("No hay indicadores ni gráficos para personalizar con tus permisos.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("No se pudo guardar tu elección. Vuelve a intentarlo.");
  });
});
