// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import type { GridFetcher } from "../../grid/types";
import { ReportPage } from "../ReportPage";
import type { ReportDefClient, ReportParams } from "../report-model";

afterEach(cleanup);

const report: ReportDefClient = {
  id: "test.trial_balance",
  label: "Balance de prueba",
  params: [
    { name: "from", label: "Desde", type: "date" },
    { name: "to", label: "Hasta", type: "date" },
    { name: "level", label: "Nivel", type: "number", min: 1, max: 8 },
    { name: "business_unit", label: "Unidad de negocio", type: "enum", options: [{ value: "a", label: "A" }] },
  ],
  hiddenParams: ["business_unit"],
  columns: [
    { field: "code", label: "Código", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true, display: "mono" },
    { field: "debit", label: "Débito", type: "money", kind: "number", mode: "visible", filterable: true, sortable: true },
    { field: "credit", label: "Crédito", type: "money", kind: "number", mode: "visible", filterable: true, sortable: true },
  ],
  totals: ["debit"],
  links: { code: { entity: "accounting.account", idField: "account_id" } },
};

const setup = (props: Partial<Parameters<typeof ReportPage>[0]> = {}) => {
  const calls: ReportParams[] = [];
  const grid = vi.fn<GridFetcher>(async () => ({
    rows: [{ id: "r1", code: "1105", account_id: "acc-1", debit: "1500000", credit: "0" }],
    total: 1,
    aggregates: { "sum:debit": "1500000.0000", "sum:credit": "9" },
  }));
  const fetcher = (params: ReportParams): GridFetcher => {
    calls.push(params);
    return grid;
  };
  renderEs(<ReportPage report={report} initialParams={{ from: "2026-10-01", to: "2026-10-31", level: 2 }} reportFetcher={fetcher} today="2026-10-30" debounceMs={5} {...props} />);
  return { calls, grid };
};

describe("ReportPage", () => {
  it("builds the parameter bar from the schema and sends params with the grid state", async () => {
    const { calls } = setup();
    await screen.findByText("1105");
    expect(screen.getByLabelText("Desde")).toBeTruthy();
    expect(screen.getByLabelText("Hasta")).toBeTruthy();
    expect(screen.getByLabelText("Nivel")).toBeTruthy();
    expect(screen.queryByLabelText("Unidad de negocio")).toBeNull();
    expect(calls.at(-1)).toMatchObject({ level: 2, from: "2026-10-01" });
    fireEvent.change(screen.getByLabelText("Nivel"), { target: { value: "4" } });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ level: 4, from: "2026-10-01", to: "2026-10-31" }));
  });

  it("applies a quick range to from and to", async () => {
    const { calls } = setup();
    await screen.findByText("1105");
    fireEvent.click(screen.getByRole("button", { name: "Hoy" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ from: "2026-10-30", to: "2026-10-30" }));
    fireEvent.click(screen.getByRole("button", { name: "Este año" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ from: "2026-01-01", to: "2026-12-31" }));
  });

  it("totals footer shows the aggregates of the columns in totals only", async () => {
    setup();
    await screen.findByText("1105");
    const foot = document.querySelector("tfoot")!;
    expect(foot.textContent).toContain("$ 1.500.000,00");
    expect(foot.textContent).not.toContain("$ 9,00");
  });

  it("a column with link opens the record through onRowOpen", async () => {
    const onRowOpen = vi.fn();
    setup({ onRowOpen });
    fireEvent.click(await screen.findByRole("button", { name: "1105" }));
    expect(onRowOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), { entity: "accounting.account", id: "acc-1" });
  });

  it("saves the parameters under the report entity with the view", async () => {
    const onSave = vi.fn(async () => {});
    setup({ savedViews: { views: [], onSave } });
    await screen.findByText("1105");
    fireEvent.click(screen.getByRole("button", { name: "Guardar vista" }));
    fireEvent.change(screen.getByLabelText("Nombre de la vista"), { target: { value: "Octubre" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith("Octubre", false, expect.objectContaining({ params: { from: "2026-10-01", to: "2026-10-31", level: 2 } }));
  });
});
