// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ResultTable } from "../ResultTable";
import { renderEs } from "../../shell/__tests__/intl";

// A `kernel.data.query` result in the chat (design §7.1, rules 14 and 17): the rows with the grid's cell formatting,
// capped at 50, and the three ways out: open it as a grid, export it, save it as a report (phase 5).

afterEach(cleanup);

const columns = [
  { field: "legal_name", label: "Razón social", type: "text" },
  { field: "balance", label: "Saldo", type: "money" },
  { field: "created_at", label: "Creado", type: "datetime" },
  { field: "active", label: "Activo", type: "boolean" },
];
const rows = [
  { id: "1", legal_name: "Café del Norte S.A.S.", balance: "1234567.0000", created_at: "2026-10-27T15:30:00Z", active: true },
  { id: "2", legal_name: "Tostadora Sur", balance: 0, created_at: null, active: false },
];
const state = { filters: [{ field: "city", op: "eq" as const, value: "Bogotá" }], sort: [], page: 1, pageSize: 50 };

describe("ResultTable", () => {
  it("renders the rows with the grid's formatting: money, dates in the company zone, Sí / No", () => {
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={2} state={state} timeZone="America/Bogota" />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Razón social", "Saldo", "Creado", "Activo"]);
    expect(within(table).getByText("Café del Norte S.A.S.")).toBeTruthy();
    expect(within(table).getByText("$ 1.234.567,00")).toBeTruthy();
    // 15:30 UTC is 10:30 in Bogotá.
    expect(within(table).getByText(/2026\/10\/27 10:30/)).toBeTruthy();
    expect(within(table).getAllByText("Sí")).toHaveLength(1);
    expect(within(table).getAllByText("No")).toHaveLength(1);
    // Money is right-aligned.
    expect(within(table).getByText("$ 1.234.567,00").className).toMatch(/text-right|erp-num/);
  });

  it("shows a date and time in the company's zone, whatever the browser's, and a date alone as the same day", () => {
    const cols = [{ field: "created_at", label: "Creado", type: "datetime" }, { field: "due", label: "Vence", type: "date" }];
    const data = [{ id: "1", created_at: "2026-10-28T03:30:00Z", due: "2026-10-27" }];
    const { unmount } = renderEs(<ResultTable entity="e" rows={data} columns={cols} state={state} timeZone="America/Bogota" />);
    expect(screen.getByText(/^2026\/10\/27 22:30/)).toBeTruthy();
    expect(screen.getByText("2026/10/27")).toBeTruthy();
    unmount();
    renderEs(<ResultTable entity="e" rows={data} columns={cols} state={state} timeZone="Asia/Tokyo" />);
    expect(screen.getByText(/^2026\/10\/28 12:30/)).toBeTruthy();
    expect(screen.getByText("2026/10/27")).toBeTruthy();
  });

  it("a masked field shows •••••• like the grid, a hidden one has no column, and so does a field the host does not offer", () => {
    const cols = [
      { field: "legal_name", label: "Razón social", type: "text", mode: "visible" as const },
      { field: "credit_limit", label: "Cupo", type: "money", mode: "masked" as const },
      { field: "balance", label: "Saldo", type: "money", mode: "hidden" as const },
    ];
    renderEs(<ResultTable entity="core.party" rows={[{ id: "1", legal_name: "A", credit_limit: null, balance: null, extra: {} }]} columns={cols} state={state} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Razón social", "Cupo"]);
    const masked = screen.getByText("••••••");
    expect(masked.tagName).toBe("SPAN");
    expect(masked.closest("td")!.className).toMatch(/erp-masked/);
    expect(screen.queryByText("—")).toBeNull();
  });

  it("zero money and no value are a dash, as in the grid", () => {
    renderEs(<ResultTable entity="e" rows={[{ id: "1", total: 0, note: null }]} columns={[{ field: "total", type: "money" }, { field: "note", type: "text" }]} state={state} />);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("without column metadata it shows the row keys, never the id, and leaves values as they came", () => {
    renderEs(<ResultTable entity="core.party" rows={[{ id: "1", legal_name: "A", flag: true }]} state={state} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["legal name", "flag"]);
    expect(screen.getByText("Sí")).toBeTruthy();
  });

  it("shows only the columns the rows have (a masked or hidden field is not there), in the order the server gave", () => {
    renderEs(<ResultTable entity="core.party" rows={[{ id: "1", balance: 5, legal_name: "A" }]} columns={columns} state={state} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Saldo", "Razón social"]);
  });

  it("says how many rows it shows of the total and notes a result cut at 50", () => {
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={120} truncated state={state} />);
    expect(screen.getByText(/2 de 120/)).toBeTruthy();
    expect(screen.getByText(/truncado a 50 filas/i)).toBeTruthy();
  });

  it("has no truncation note when the result is complete", () => {
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={2} state={state} />);
    expect(screen.queryByText(/truncado/i)).toBeNull();
  });

  it("shows an empty result as such", () => {
    renderEs(<ResultTable entity="core.party" rows={[]} columns={columns} total={0} state={state} />);
    expect(screen.getByText(/Sin resultados/)).toBeTruthy();
  });

  it("Abrir como grid hands the entity and the query's state to the shell", () => {
    const onOpenGrid = vi.fn();
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={2} state={state} onOpenGrid={onOpenGrid} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir como grid" }));
    expect(onOpenGrid).toHaveBeenCalledWith("core.party", state);
  });

  it("links each row's name to its record and a reference to the referenced record, by its label (rule 21)", () => {
    const supplier = "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
    const cols = [
      { field: "description", label: "Descripción", type: "text", mode: "visible" as const, identity: true, linkable: true },
      { field: "supplier_id", label: "Proveedor", type: "ref", mode: "visible" as const, ref: { entity: "core.party", display: "legal_name" }, linkable: true },
      { field: "category_id", label: "Categoría", type: "ref", mode: "visible" as const, ref: { entity: "core.product_category", display: "name" } },
    ];
    const data = [{ id: "p1", description: "Café en grano 500 g", supplier_id: supplier, supplier_id_label: "Café del Norte S.A.S.", category_id: "c1", category_id_label: "Café" }];
    renderEs(<ResultTable entity="core.product" rows={data} columns={cols} state={state} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Descripción", "Proveedor", "Categoría"]);
    expect(screen.getByRole("link", { name: "Café en grano 500 g" }).getAttribute("href")).toBe("/r/core.product/p1");
    expect(screen.getByRole("link", { name: "Café del Norte S.A.S." }).getAttribute("href")).toBe(`/r/core.party/${supplier}`);
    // As in the grid, the links in the rows stay out of the tab order.
    for (const link of screen.getAllByRole("link")) expect(link.getAttribute("tabindex")).toBe("-1");
    // A reference the caller may not open names its record without a link.
    expect(screen.getByText("Café").closest("a")).toBeNull();
  });

  it("without the host's metadata a reference's label is not a column of its own", () => {
    renderEs(<ResultTable entity="core.product" rows={[{ id: "p1", supplier_id: "s1", supplier_id_label: "Café del Norte S.A.S." }]} state={state} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["supplier id"]);
  });

  it("Abrir como grid is not offered for an entity without a grid screen", () => {
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={2} state={state} />);
    expect(screen.queryByRole("button", { name: "Abrir como grid" })).toBeNull();
  });

  it("Excel exports the same state through /api/export", async () => {
    const fetcher = vi.fn(async () => new Response("xlsx", { status: 200, headers: { "content-disposition": 'attachment; filename="terceros.xlsx"' } }));
    const download = vi.fn();
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={2} state={state} fetcher={fetcher as unknown as typeof fetch} download={download} />);
    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/export");
    expect(JSON.parse(init.body as string)).toMatchObject({ entity: "core.party", format: "xlsx", state });
  });

  it("an export that fails says so", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: "forbidden", details: null }), { status: 403 }));
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={2} state={state} fetcher={fetcher as unknown as typeof fetch} download={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/permiso/i));
  });

  it("Guardar reporte is disabled and says it comes in phase 5", () => {
    renderEs(<ResultTable entity="core.party" rows={rows} columns={columns} total={2} state={state} />);
    const save = screen.getByRole("button", { name: "Guardar reporte" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe("Fase 5");
  });
});

describe("ResultTable, closed sets as the grid shows them (T11)", () => {
  it("an enum shows its label, never the raw value", () => {
    const cols = [{ field: "kind", label: "Tipo", type: "enum", options: [{ value: "customer", label: "Cliente" }, { value: "supplier", label: "Proveedor" }] }];
    renderEs(<ResultTable entity="core.party" rows={[{ id: "1", kind: "customer" }]} columns={cols} state={state} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Cliente")).toBeTruthy();
    expect(within(table).queryByText("customer")).toBeNull();
  });
});

describe("ResultTable, which columns show (UX-OD-6, T12)", () => {
  const many = ["a", "b", "c", "d", "e", "f", "g", "h"].map((field, i) => ({ field, label: `Col ${field.toUpperCase()}`, type: "text", ...(i === 2 ? { identity: true } : {}), ...(i >= 6 ? { hiddenByDefault: true } : {}) }));
  const row = { id: "1", a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7", h: "8" };
  const heads = () => within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent);

  it("shows the identity column first and at most six columns of the entity's default view", () => {
    renderEs(<ResultTable entity="core.party" rows={[row]} columns={many} state={state} />);
    expect(heads()).toEqual(["Col C", "Col A", "Col B", "Col D", "Col E", "Col F"]);
    expect(screen.getByRole("button", { name: "Ver todas las columnas (8)" })).toBeTruthy();
  });

  it("Ver todas las columnas expands in place, Ver menos folds it back; a table that fits has no button", () => {
    renderEs(<ResultTable entity="core.party" rows={[row]} columns={many} state={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver todas las columnas (8)" }));
    expect(heads()).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Ver menos columnas" }));
    expect(heads()).toHaveLength(6);
    cleanup();
    renderEs(<ResultTable entity="core.party" rows={[row]} columns={many.slice(0, 3)} state={state} />);
    expect(screen.queryByRole("button", { name: /columnas/ })).toBeNull();
  });
});
