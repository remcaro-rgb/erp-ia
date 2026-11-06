// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { DataGrid } from "../DataGrid";
import { GridFetchError } from "../fetch-grid";
import type { GridColumn, GridFetcher, GridRow, GridStateInput } from "../types";

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

  it("while the first page loads it says Cargando… with skeleton rows, never 0 registros or an empty body", async () => {
    let resolve!: (page: { rows: GridRow[]; total: number }) => void;
    const fetcher = vi.fn<GridFetcher>(() => new Promise((r) => (resolve = r)));
    renderEs(<DataGrid entity="core.party" title="Terceros" columns={columns} fetcher={fetcher} debounceMs={20} />);
    const grid = screen.getByRole("region", { name: "Terceros" });
    expect(within(grid).getByText("Cargando…")).toBeTruthy();
    expect(within(grid).queryByText(/0 registros/)).toBeNull();
    expect(within(grid).queryByText("Sin resultados")).toBeNull();
    expect(grid.querySelectorAll("tbody tr.erp-grid__skeleton").length).toBeGreaterThan(0);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    resolve({ rows, total: 2 });
    await within(grid).findByText("2 registros");
    expect(within(grid).queryByText("Cargando…")).toBeNull();
    expect(grid.querySelectorAll("tbody tr.erp-grid__skeleton")).toHaveLength(0);
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

  it("shift-click appends a sort level and shows its number, up to five", async () => {
    const wide: GridColumn[] = ["a", "b", "c", "d", "e", "f"].map((f) => ({ field: f, label: `Col ${f}`, type: "text", kind: "text", mode: "visible", filterable: true, sortable: true }));
    const fetcher = vi.fn<GridFetcher>(async () => ({ rows: [{ id: "1", a: "x" }], total: 1 }));
    renderEs(<DataGrid entity="x.y" title="Pruebas" columns={wide} fetcher={fetcher} debounceMs={20} />);
    await screen.findByText("x");
    fireEvent.click(screen.getByRole("button", { name: "Ordenar por Col a" }));
    fireEvent.click(screen.getByRole("button", { name: "Ordenar por Col b" }), { shiftKey: true });
    await waitFor(() => expect(lastState(fetcher).sort).toEqual([{ field: "a", dir: "asc" }, { field: "b", dir: "asc" }]));
    expect(screen.getByRole("columnheader", { name: /Col a/ }).querySelector("sup")?.textContent).toBe("1");
    expect(screen.getByRole("columnheader", { name: /Col b/ }).querySelector("sup")?.textContent).toBe("2");
    for (const f of ["c", "d", "e"]) fireEvent.click(screen.getByRole("button", { name: `Ordenar por Col ${f}` }), { shiftKey: true });
    await waitFor(() => expect(lastState(fetcher).sort).toHaveLength(5));
    fireEvent.click(screen.getByRole("button", { name: "Ordenar por Col f" }), { shiftKey: true });
    expect(await screen.findByText("Máximo 5 niveles de orden")).toBeTruthy();
    expect(lastState(fetcher).sort).toHaveLength(5);
  });

  it("Agrupar por sends groupBy and renders group rows with subtotals that equal the sum of their page lines", async () => {
    const groups = [
      { level: 1, keys: { dian_status: "complete" }, count: 1, aggregates: { "sum:credit_limit": "1234567.0000" } },
      { level: 1, keys: { dian_status: "missing: 2" }, count: 1, aggregates: { "sum:credit_limit": "1000000.0000" } },
    ];
    const fetcher = vi.fn<GridFetcher>(async () => ({ rows, total: 2, aggregates: { "sum:credit_limit": "2234567.0000" }, groups }));
    renderEs(<DataGrid entity="core.party" title="Terceros" columns={columns} fetcher={fetcher} debounceMs={20} />);
    await screen.findByText("Almacenes Éxito S.A.");
    expect(document.querySelector(".erp-grid__group")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agrupar por" }));
    fireEvent.change(screen.getByLabelText("Agregar campo para agrupar"), { target: { value: "dian_status" } });
    await waitFor(() => expect(lastState(fetcher).groupBy).toEqual(["dian_status"]));
    const groupRows = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("tr.erp-grid__group.erp-grid__group--l1")];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(groupRows[0]!.textContent).toContain("Datos DIAN: complete (1)");
    // The subtotal of each group is the sum of its lines on the page.
    const sums = groupRows.map((r) => r.textContent!.match(/\$ [\d.]+,\d\d/)?.[0]);
    expect(sums).toEqual(["$ 1.234.567,00", "$ 1.000.000,00"]);
    // A click collapses the group; the footer counts what is hidden.
    fireEvent.click(within(groupRows[0]!).getByRole("button", { name: /Datos DIAN: complete/ }));
    expect(screen.queryByText("Almacenes Éxito S.A.")).toBeNull();
    expect(screen.getByText("1 oculta en grupos contraídos")).toBeTruthy();
    // Ver líneas turns the group keys into conditions.
    fireEvent.click(within(groupRows[1]!).getByRole("button", { name: "Ver líneas" }));
    await waitFor(() => expect(lastState(fetcher).filters).toEqual([{ field: "dian_status", op: "eq", value: "missing: 2" }]));
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
    // The filter's total sits under its own column (OD-5), no longer as text in the footer.
    expect(screen.queryByText(/Suma cupo filtrado/)).toBeNull();
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Seleccionar fila" })[0]!);
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Seleccionar fila" })[1]!);
    expect(screen.getByText("2 seleccionadas")).toBeTruthy();
    expect(screen.getByText("Cupo seleccionado: $ 2.234.567,00")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar todas las filas de la página" }));
    expect(screen.queryByText("2 seleccionadas")).toBeNull();
  });

  it("pins the selection and identity columns (OD-4) and totals the filter under its money columns in a sticky tfoot (OD-5)", async () => {
    const withIdentity = columns.map((c) => (c.field === "legal_name" ? { ...c, identity: true } : c));
    setup({ columns: withIdentity });
    await screen.findByText("Almacenes Éxito S.A.");
    const grid = screen.getByRole("region", { name: "Terceros" });
    const table = grid.querySelector("table")!;
    // The identity column comes first, after the selection column, and both are pinned in every row.
    const head = table.querySelector("thead tr")!;
    expect(head.children[0]!.className).toMatch(/is-pinned/);
    expect(head.children[1]!.textContent).toMatch(/Razón social/);
    expect(head.children[1]!.className).toMatch(/is-pinned/);
    expect(head.children[2]!.className).not.toMatch(/is-pinned/);
    for (const tr of table.querySelectorAll("tbody tr[data-row], thead tr.erp-grid__filters")) {
      expect(tr.children[0]!.className).toMatch(/is-pinned/);
      expect(tr.children[1]!.className).toMatch(/is-pinned/);
      expect(tr.children[2]!.className).not.toMatch(/is-pinned/);
    }
    const cell = screen.getByText("Almacenes Éxito S.A.").closest("td")!;
    expect(cell.className).toMatch(/is-pinned/);
    // tfoot: "Suma" in the identity cell, the filter's sum of Cupo under Cupo, nothing under the other columns.
    const foot = table.querySelector("tfoot tr")!;
    const cupoIndex = [...head.children].findIndex((th) => th.textContent?.startsWith("Cupo"));
    expect(foot.children[1]!.textContent).toBe("Suma");
    expect(foot.children[1]!.className).toMatch(/is-pinned/);
    expect(foot.children[cupoIndex]!.textContent).toBe("$ 6.000.000,00");
    expect(foot.children[cupoIndex]!.className).toMatch(/erp-num/);
    // The masked Saldo has no sum (it never totals), and the footer bar keeps only the pager and the selection.
    const saldoIndex = [...head.children].findIndex((th) => th.textContent?.startsWith("Saldo"));
    expect(foot.children[saldoIndex]!.textContent).toBe("");
    expect(foot.children).toHaveLength(head.children.length);
    expect(within(grid.querySelector(".erp-grid__ft") as HTMLElement).queryByText(/6\.000\.000/)).toBeNull();
  });

  it("has no tfoot without money columns or rows", async () => {
    setup({ columns: columns.filter((c) => c.type !== "money") });
    await screen.findByText("Almacenes Éxito S.A.");
    expect(document.querySelector("tfoot")).toBeNull();
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

  it("a refused fetch with details shows the first detail in the alert instead of the code's message", async () => {
    const fetcher = vi.fn<GridFetcher>(async () => {
      throw new GridFetchError("forbidden", 403, ["Sin acceso"]);
    });
    renderEs(<DataGrid entity="accounting.report" title="Auxiliar" columns={columns} fetcher={fetcher} debounceMs={20} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Sin acceso");
  });

  it("a refusal without details keeps the code's message ('No tienes permiso para hacer esto.')", async () => {
    const fetcher = vi.fn<GridFetcher>(async () => {
      throw new GridFetchError("forbidden", 403, []);
    });
    renderEs(<DataGrid entity="accounting.report" title="Auxiliar" columns={columns} fetcher={fetcher} debounceMs={20} />);
    expect((await screen.findByRole("alert")).textContent).toContain("No tienes permiso para hacer esto.");
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

  it("hands the export the grid's filter, sort and shown columns (admin-defined ones by name), never its page or sums", async () => {
    const onExport = vi.fn();
    const withExtra: GridColumn[] = [
      ...columns,
      { field: "extra.ruta", label: "Ruta", type: "custom:text", kind: "text", mode: "visible", filterable: true, sortable: true, hiddenByDefault: true },
    ];
    setup({ onExport, columns: withExtra, initialState: { columns: ["legal_name", "extra.ruta", "balance", "credit_limit"], page: 3, pageSize: 25 } });
    await screen.findByText("Almacenes Éxito S.A.");
    fireEvent.change(screen.getByLabelText("Filtrar Razón social"), { target: { value: "éxito" } });
    await waitFor(() => expect(screen.getByLabelText("Filtrar Razón social").className).toMatch(/is-on/));
    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    const [format, state] = onExport.mock.calls[0]!;
    expect(format).toBe("xlsx");
    expect(state).toMatchObject({ page: 1, filters: [{ field: "legal_name", op: "contains", value: "éxito" }] });
    // The shown columns in the grid's order: a masked one stays (it exports as ••••••), a hidden one never was there.
    expect(state.columns).toEqual(["legal_name", "extra.ruta", "balance", "credit_limit"]);
    expect(state.aggregates).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    expect(onExport.mock.calls.map((c) => c[0])).toEqual(["xlsx", "pdf", "csv"]);
  });

  it("runs the export itself when no handler is given: asks the server, saves the file, says so, and one at a time", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
    let finish: (response: Response) => void = () => undefined;
    const exportFetch = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", exportFetch);
    try {
      setup();
      await screen.findByText("Almacenes Éxito S.A.");
      fireEvent.click(screen.getByRole("button", { name: "CSV" }));
      expect((await screen.findByRole("status")).textContent).toBe("Generando CSV…");
      // One at a time: the buttons wait for the running export.
      for (const name of ["PDF", "Excel", "CSV"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      expect(exportFetch).toHaveBeenCalledTimes(1);
      const [url, init] = exportFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/export");
      expect(JSON.parse(init.body as string)).toMatchObject({ entity: "core.party", format: "csv", title: "Terceros", state: { page: 1 } });
      finish(new Response("a;b", { status: 200, headers: { "content-disposition": 'attachment; filename="terceros-2026-10-28.csv"' } }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Descarga lista: terceros-2026-10-28.csv"));
      expect(click).toHaveBeenCalledTimes(1);
      expect((screen.getByRole("button", { name: "Excel" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      click.mockRestore();
    }
  });

  it("says why an export was refused, in Spanish", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "forbidden", details: null }), { status: 403 })));
    try {
      setup();
      await screen.findByText("Almacenes Éxito S.A.");
      fireEvent.click(screen.getByRole("button", { name: "PDF" }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No se pudo exportar. No tienes permiso para hacer esto."));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("DataGrid, empty states (T13)", () => {
  const none = async () => ({ rows: [], total: 0, aggregates: {} });
  it("an entity with no records says so, with the entity's create action; a base filter or a sort is not the user's filtering", async () => {
    setup({ fetcher: vi.fn<GridFetcher>(none), baseFilters: [{ field: "status", op: "eq", value: "draft" }], emptyAction: <button type="button">Crear tercero</button> });
    expect(await screen.findByText("Aún no hay registros")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear tercero" })).toBeTruthy();
    expect(screen.queryByText("Sin resultados con estos filtros")).toBeNull();
  });

  it("the user's own column filter says nothing matches, without the create action", async () => {
    setup({ fetcher: vi.fn<GridFetcher>(none), emptyAction: <button type="button">Crear tercero</button>, initialState: { columnFilters: { legal_name: "zzz" } } });
    expect(await screen.findByText("Sin resultados con estos filtros")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Crear tercero" })).toBeNull();
  });
});

// Imprimir on a grid (Task 16): only for an entity that prints (the page passes onPrint), with the export's state; a refusal shows its text.
describe("DataGrid Imprimir", () => {
  it("has no Imprimir button without onPrint", async () => {
    const { fetcher } = setup();
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Imprimir" })).toBeNull();
  });

  it("prints what the grid shows (filters, sort, visible columns, page 1) and shows a refusal next to the button", async () => {
    const onPrint = vi.fn<(state: GridStateInput) => Promise<string | null>>(async () => "La lista supera las 2.000 filas");
    const { fetcher } = setup({ onPrint, initialState: { columnFilters: { legal_name: "caf" } } });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Imprimir" }));
    await waitFor(() => expect(onPrint).toHaveBeenCalledTimes(1));
    const state = onPrint.mock.calls[0]![0]!;
    expect(state).toMatchObject({ page: 1, sort: [], filters: [{ field: "legal_name", op: "contains", value: "caf" }] });
    expect(state.columns).toEqual(["seq", "legal_name", "kind", "credit_limit", "balance", "notes", "dian_status"]);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "La lista supera las 2.000 filas");
  });

  it("hands the selected rows of the page to the screen's selection action (Por facturar's «Crear facturas», Task 20 fix round 1)", async () => {
    const seen: string[][] = [];
    setup({
      selectionActions: (selected) => {
        seen.push(selected.map((r) => r.id));
        return (
          <button type="button" disabled={selected.length === 0}>
            Crear facturas
          </button>
        );
      },
    });
    await screen.findByText("Almacenes Éxito S.A.");
    expect(screen.getByRole("button", { name: "Crear facturas" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Seleccionar fila" })[1]!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Crear facturas" })).toHaveProperty("disabled", false));
    expect(seen.at(-1)).toEqual(["b"]);
  });
});

