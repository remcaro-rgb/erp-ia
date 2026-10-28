// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { DataGrid } from "../DataGrid";
import type { GridColumn, GridFetcher, GridRow } from "../types";

afterEach(cleanup);

// The universal grid (design §9, rule 20, prototype `gridHtml`): server-driven filters, sort and pages, the filter
// row by type, the column chooser, money totals and the selection.

const columns: GridColumn[] = [
  { field: "seq", label: "N.º", type: "number", kind: "number", mode: "visible", filterable: true, sortable: true },
  { field: "legal_name", label: "Razón social", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true },
  {
    field: "kind",
    label: "Tipo",
    type: "enum",
    kind: "enum",
    mode: "visible",
    filterable: true,
    sortable: true,
    options: [
      { value: "customer", label: "Cliente" },
      { value: "supplier", label: "Proveedor" },
    ],
  },
  { field: "credit_limit", label: "Cupo", type: "money", kind: "number", mode: "visible", filterable: true, sortable: true },
  { field: "balance", label: "Saldo", type: "money", kind: "number", mode: "masked", filterable: true, sortable: true },
  { field: "secret", label: "Secreto", type: "text", kind: "text", mode: "hidden", filterable: true, sortable: true },
  { field: "notes", label: "Notas", type: "text", kind: "text", mode: "visible", filterable: false, sortable: false },
  { field: "dian_status", label: "Datos DIAN", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true, display: "dian" },
];

const rows: GridRow[] = [
  { id: "a", seq: "1", legal_name: "Almacenes Éxito S.A.", kind: ["customer"], credit_limit: "1234567.0000", balance: null, notes: "", dian_status: "complete" },
  { id: "b", seq: "2", legal_name: "Café del Norte S.A.S.", kind: ["customer", "supplier"], credit_limit: "1000000", balance: null, notes: "x", dian_status: "missing: 2" },
];

const setup = (props: Partial<Parameters<typeof DataGrid>[0]> = {}) => {
  const fetcher = vi.fn<GridFetcher>(async () => ({ rows, total: 120, aggregates: { "sum:credit_limit": "6000000.0000" } }));
  const onRowOpen = vi.fn();
  renderEs(<DataGrid entity="core.party" title="Terceros" columns={columns} fetcher={fetcher} onRowOpen={onRowOpen} debounceMs={20} {...props} />);
  return { fetcher, onRowOpen };
};

const lastState = (fetcher: ReturnType<typeof vi.fn<GridFetcher>>) => fetcher.mock.calls.at(-1)![0];

describe("DataGrid", () => {
  it("renders the filter row with one input per filterable column", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    const filters = screen.getByRole("row", { name: "Filtros" });
    expect(within(filters).getAllByLabelText(/^Filtrar /).map((el) => el.getAttribute("aria-label"))).toEqual([
      "Filtrar N.º",
      "Filtrar Razón social",
      "Filtrar Tipo",
      "Filtrar Cupo",
      "Filtrar Datos DIAN",
    ]);
    // A masked column is shown but its filter is disabled; a hidden one is not there at all.
    expect((within(filters).getByLabelText("Filtro no disponible") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("columnheader", { name: /Secreto/ })).toBeNull();
    // The first request asks for the visible columns and the sums of the visible money columns.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(lastState(fetcher)).toMatchObject({ filters: [], sort: [], page: 1, pageSize: 10, aggregates: [{ field: "credit_limit", fn: "sum" }] });
    expect(lastState(fetcher).columns).toEqual(["seq", "legal_name", "kind", "credit_limit", "balance", "notes", "dian_status"]);
  });

  it("typing in a filter calls the fetcher with the new state after debounce", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    fireEvent.change(screen.getByLabelText("Filtrar Razón social"), { target: { value: "éxito" } });
    fireEvent.change(screen.getByLabelText("Filtrar Cupo"), { target: { value: ">= 1.000.000" } });
    fireEvent.change(screen.getByLabelText("Filtrar Tipo"), { target: { value: "supplier" } });
    // Nothing yet: the grid waits for the typing to settle.
    expect(fetcher).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(lastState(fetcher)).toMatchObject({
      page: 1,
      filters: [
        { field: "legal_name", op: "contains", value: "éxito" },
        { field: "credit_limit", op: "gte", value: 1_000_000, join: "and" },
        { field: "kind", op: "in", value: ["supplier"], join: "and" },
      ],
    });
    // Active filters are tinted.
    expect(screen.getByLabelText("Filtrar Razón social").className).toMatch(/is-on/);
  });

  it("sorts by a click, descends on the second, and adds a second key with shift", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    fireEvent.click(screen.getByRole("button", { name: "Ordenar por Razón social" }));
    await waitFor(() => expect(lastState(fetcher).sort).toEqual([{ field: "legal_name", dir: "asc" }]));
    expect(screen.getByRole("columnheader", { name: /Razón social/ }).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(screen.getByRole("button", { name: "Ordenar por Razón social" }));
    await waitFor(() => expect(lastState(fetcher).sort).toEqual([{ field: "legal_name", dir: "desc" }]));
    fireEvent.click(screen.getByRole("button", { name: "Ordenar por N.º" }), { shiftKey: true });
    await waitFor(() => expect(lastState(fetcher).sort).toEqual([{ field: "legal_name", dir: "desc" }, { field: "seq", dir: "asc" }]));
    // Masked and non-sortable columns offer no sort.
    expect(screen.queryByRole("button", { name: "Ordenar por Saldo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ordenar por Notas" })).toBeNull();
  });

  it("pages 10 / 25 / 50 / 100 on the server with page buttons", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    expect(screen.getByText("Filas 1–10 de 120")).toBeTruthy();
    const pager = screen.getByRole("navigation", { name: "Página 1 de 12" });
    expect(within(pager).getAllByRole("button").map((b) => b.textContent)).toEqual(["‹", "1", "2", "3", "12", "›"]);
    fireEvent.click(within(pager).getByRole("button", { name: "2" }));
    await waitFor(() => expect(lastState(fetcher).page).toBe(2));
    expect(await screen.findByText("Filas 11–20 de 120")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filas por página"), { target: { value: "25" } });
    await waitFor(() => expect(lastState(fetcher)).toMatchObject({ page: 1, pageSize: 25 }));
    expect(screen.getByLabelText("Filas por página").querySelectorAll("option")).toHaveLength(4);
  });

  it("shows money as $ 1.234.567,00, masks what the role may not see and totals the filter and the selection", async () => {
    setup();
    await screen.findByText("Almacenes Éxito S.A.");
    expect(screen.getByText("$ 1.234.567,00")).toBeTruthy();
    expect(screen.getAllByTitle("Enmascarado para tu rol")).toHaveLength(2);
    expect(screen.getByText("Completo")).toBeTruthy();
    expect(screen.getByText("Faltan 2")).toBeTruthy();
    expect(screen.getByText("Cliente, Proveedor")).toBeTruthy();
    expect(screen.getByText(/Suma cupo filtrado: \$ 6\.000\.000,00/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Seleccionar fila" })[0]!);
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Seleccionar fila" })[1]!);
    expect(screen.getByText("2 seleccionadas")).toBeTruthy();
    expect(screen.getByText("Cupo seleccionado: $ 2.234.567,00")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar todas las filas de la página" }));
    expect(screen.queryByText("2 seleccionadas")).toBeNull();
  });

  it("chooses the columns and opens a row", async () => {
    const { fetcher, onRowOpen } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    fireEvent.click(screen.getByRole("button", { name: "Columnas" }));
    const chooser = screen.getByRole("group", { name: "Columnas" });
    // The hidden column is not offered.
    expect(within(chooser).queryByLabelText("Secreto")).toBeNull();
    fireEvent.click(within(chooser).getByLabelText("Tipo"));
    await waitFor(() => expect(lastState(fetcher).columns).not.toContain("kind"));
    expect(screen.queryByRole("columnheader", { name: /Tipo/ })).toBeNull();
    fireEvent.click(screen.getByText("Café del Norte S.A.S."));
    expect(onRowOpen).toHaveBeenCalledWith(rows[1]);
    // A row also opens from the keyboard.
    const row = screen.getByText("Almacenes Éxito S.A.").closest("tr")!;
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onRowOpen).toHaveBeenLastCalledWith(rows[0]);
  });

  it("applies fixed filters (the party switches) to every result and shows the server's refusal", async () => {
    const fetcher = vi.fn<GridFetcher>(async () => {
      throw Object.assign(new Error("field_hidden"), { code: "field_hidden" });
    });
    renderEs(
      <DataGrid entity="core.party" title="Terceros" columns={columns} fetcher={fetcher} baseFilters={[{ field: "kind", op: "eq", value: "customer" }]} debounceMs={20} />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(lastState(fetcher).filters).toEqual([{ field: "kind", op: "eq", value: "customer" }]);
    expect((await screen.findByRole("alert")).textContent).toContain("Un campo oculto o enmascarado para tu rol no se puede usar para filtrar ni ordenar.");
  });
});
