// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { DataGrid } from "../DataGrid";
import { initialView, moveColumn, setColumnShown, stepColumn } from "../grid-model";
import { savedStateOf, viewFromSaved, type SavedGridState } from "../saved-views";
import type { GridColumn, GridFetcher, GridRow } from "../types";

afterEach(cleanup);

// Movable columns (design §22.12, rule 20): the user reorders the grid's columns by dragging a header or with
// Alt+← / Alt+→ on it, and with ↑ / ↓ in the column chooser. The order is part of the view: it goes with every grid
// request and export and it is kept by a saved view. The identity column (the entity's display field) stays first
// and pinned (OD-4); a column the user hides keeps its place for when it comes back.

const col = (field: string, label: string, extra: Partial<GridColumn> = {}): GridColumn => ({
  field,
  label,
  type: "text",
  kind: "text",
  mode: "visible",
  filterable: true,
  sortable: true,
  ...extra,
});

const columns: GridColumn[] = [
  col("seq", "N.º", { type: "number", kind: "number" }),
  col("legal_name", "Razón social", { identity: true }),
  col("document_number", "Número"),
  col("municipality_code", "Municipio"),
  col("credit_limit", "Cupo", { type: "money", kind: "number" }),
  col("phone", "Teléfono", { hiddenByDefault: true }),
  col("secret", "Secreto", { mode: "hidden" }),
];

const rows: GridRow[] = [
  { id: "a", seq: "1", legal_name: "Almacenes Éxito S.A.", document_number: "890900608", municipality_code: "11001", credit_limit: "5000000" },
  { id: "b", seq: "2", legal_name: "Café del Norte S.A.S.", document_number: "900373115", municipality_code: "05001", credit_limit: "1000000" },
];

const setup = (props: Partial<Parameters<typeof DataGrid>[0]> = {}) => {
  const fetcher = vi.fn<GridFetcher>(async () => ({ rows, total: 1, aggregates: { "sum:credit_limit": "5000000" } }));
  const onExport = vi.fn();
  renderEs(<DataGrid entity="core.party" title="Terceros" columns={columns} fetcher={fetcher} onExport={onExport} debounceMs={20} {...props} />);
  return { fetcher, onExport };
};

const lastState = (fetcher: ReturnType<typeof vi.fn<GridFetcher>>) => fetcher.mock.calls.at(-1)![0];
/** The labels of the column headers, after the selection column. */
const headers = () =>
  screen
    .getAllByRole("columnheader")
    .slice(1)
    .filter((th) => th.closest("tr")?.className !== "erp-grid__filters")
    .map((th) => th.textContent!.replace(/[▲▼↕]/g, "").trim());
const header = (label: string) => {
  const th = screen.getAllByRole("columnheader").find((el) => el.textContent!.replace(/[▲▼↕]/g, "").trim() === label);
  if (!th) throw new Error(`no header ${label}`);
  return th;
};

/** A DataTransfer good enough for jsdom's drag events. */
const transfer = () => {
  const data = new Map<string, string>();
  return { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", effectAllowed: "", dropEffect: "" };
};

describe("moveColumn and the column order (grid-model)", () => {
  it("starts with the identity column first and remembers every offered column in order", () => {
    const view = initialView(columns);
    expect(view.columns).toEqual(["legal_name", "seq", "document_number", "municipality_code", "credit_limit"]);
    expect(view.order).toEqual(["legal_name", "seq", "document_number", "municipality_code", "credit_limit", "phone"]);
  });

  it("moves a shown column to an index; the identity column never moves and nothing goes before it", () => {
    const view = initialView(columns);
    expect(moveColumn(view, "municipality_code", 1, "legal_name").columns).toEqual(["legal_name", "municipality_code", "seq", "document_number", "credit_limit"]);
    expect(moveColumn(view, "seq", 4, "legal_name").columns).toEqual(["legal_name", "document_number", "municipality_code", "credit_limit", "seq"]);
    // Index 0 belongs to the identity column: asking for it lands right after it.
    expect(moveColumn(view, "credit_limit", 0, "legal_name").columns).toEqual(["legal_name", "credit_limit", "seq", "document_number", "municipality_code"]);
    // Moving the identity column is a no-op.
    expect(moveColumn(view, "legal_name", 3, "legal_name")).toBe(view);
    // Out of range or unknown: nothing changes.
    expect(moveColumn(view, "seq", 1, "legal_name")).toBe(view);
    expect(moveColumn(view, "nope", 2, "legal_name")).toBe(view);
  });

  it("a hidden column keeps its place in the order and comes back there", () => {
    let view = initialView(columns);
    view = setColumnShown(view, "document_number", false);
    expect(view.columns).toEqual(["legal_name", "seq", "municipality_code", "credit_limit"]);
    // Columns move around it…
    view = moveColumn(view, "credit_limit", 1, "legal_name");
    expect(view.columns).toEqual(["legal_name", "credit_limit", "seq", "municipality_code"]);
    expect(view.order).toEqual(["legal_name", "credit_limit", "seq", "document_number", "municipality_code", "phone"]);
    // …and it comes back where it was.
    view = setColumnShown(view, "document_number", true);
    expect(view.columns).toEqual(["legal_name", "credit_limit", "seq", "document_number", "municipality_code"]);
    // A column offered but off at first comes in at its place in the order.
    view = setColumnShown(view, "phone", true);
    expect(view.columns.at(-1)).toBe("phone");
    // The last shown column cannot be hidden.
    const one = { ...view, columns: ["legal_name"] };
    expect(setColumnShown(one, "legal_name", false)).toBe(one);
  });

  it("steps a column one place in the chooser's order (shown or not), never above the identity column", () => {
    let view = initialView(columns);
    view = stepColumn(view, "phone", -1, "legal_name");
    expect(view.order).toEqual(["legal_name", "seq", "document_number", "municipality_code", "phone", "credit_limit"]);
    expect(view.columns).toEqual(["legal_name", "seq", "document_number", "municipality_code", "credit_limit"]);
    view = stepColumn(view, "municipality_code", -1, "legal_name");
    expect(view.columns).toEqual(["legal_name", "seq", "municipality_code", "document_number", "credit_limit"]);
    const top = stepColumn(view, "seq", -1, "legal_name");
    expect(top).toBe(view);
    expect(stepColumn(view, "legal_name", 1, "legal_name")).toBe(view);
  });

  it("the order round-trips through a saved view", () => {
    const moved = moveColumn(initialView(columns), "municipality_code", 1, "legal_name");
    const saved: SavedGridState = JSON.parse(JSON.stringify(savedStateOf(columns, moved)));
    expect(saved.columns).toEqual(["legal_name", "municipality_code", "seq", "document_number", "credit_limit"]);
    const back = viewFromSaved(columns, saved);
    expect(back.columns).toEqual(saved.columns);
    expect(back.order?.slice(0, 5)).toEqual(saved.columns);
    // A view saved before the identity column was pinned comes back with it first.
    expect(viewFromSaved(columns, { columns: ["seq", "legal_name", "credit_limit"] }).columns).toEqual(["legal_name", "seq", "credit_limit"]);
  });
});

describe("DataGrid movable columns", () => {
  it("dragging header 3 onto position 1 reorders the headers; the next grid request carries the order", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    expect(headers()).toEqual(["Razón social", "N.º", "Número", "Municipio", "Cupo"]);
    expect(lastState(fetcher).columns).toEqual(["legal_name", "seq", "document_number", "municipality_code", "credit_limit"]);
    const dataTransfer = transfer();
    const source = header("Municipio");
    expect(source.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(source, { dataTransfer });
    expect(source.getAttribute("aria-grabbed")).toBe("true");
    // Over the left half of N.º: the drop indicator goes before it.
    fireEvent.dragOver(header("N.º"), { dataTransfer, clientX: 0 });
    expect(header("N.º").className).toMatch(/is-drop-before/);
    fireEvent.drop(header("N.º"), { dataTransfer, clientX: 0 });
    fireEvent.dragEnd(source, { dataTransfer });
    expect(headers()).toEqual(["Razón social", "Municipio", "N.º", "Número", "Cupo"]);
    expect(header("N.º").className).not.toMatch(/is-drop/);
    // Announced through the grid's status row.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Columna Municipio movida a la posición 2"));
    // The same rows in another order: nothing to ask the server for; the next request carries the new order.
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Filtrar Razón social"), { target: { value: "éxito" } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(lastState(fetcher).columns).toEqual(["legal_name", "municipality_code", "seq", "document_number", "credit_limit"]);
  });

  it("moving a column keeps the rows, the selection and the active row, and fetches nothing", async () => {
    const { fetcher } = setup();
    await screen.findByText("Café del Norte S.A.S.");
    const second = screen.getByText("Café del Norte S.A.S.").closest("tr")!;
    fireEvent.click(within(second).getByRole("checkbox", { name: "Seleccionar fila" }));
    act(() => second.focus());
    expect(second.tabIndex).toBe(0);
    expect(screen.getByText("1 seleccionada")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Ordenar por Cupo" }), { key: "ArrowLeft", altKey: true });
    // Auto-repeat: each press moves from where the last one left it, and the status says where it is now.
    fireEvent.keyDown(screen.getByRole("button", { name: "Ordenar por Cupo" }), { key: "ArrowLeft", altKey: true });
    expect(headers()).toEqual(["Razón social", "N.º", "Cupo", "Número", "Municipio"]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Columna Cupo movida a la posición 3"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 seleccionada")).toBeTruthy();
    const after = screen.getByText("Café del Norte S.A.S.").closest("tr")!;
    expect(after.getAttribute("aria-selected")).toBe("true");
    expect(after.tabIndex).toBe(0);
  });

  it("the identity column is pinned: it cannot be dragged and a drop on it lands after it", async () => {
    setup();
    await screen.findByText("Almacenes Éxito S.A.");
    expect(header("Razón social").getAttribute("draggable")).not.toBe("true");
    const dataTransfer = transfer();
    fireEvent.dragStart(header("Cupo"), { dataTransfer });
    fireEvent.dragOver(header("Razón social"), { dataTransfer, clientX: 0 });
    fireEvent.drop(header("Razón social"), { dataTransfer, clientX: 0 });
    expect(headers()).toEqual(["Razón social", "Cupo", "N.º", "Número", "Municipio"]);
  });

  it("Alt+→ and Alt+← on a focused header move it and keep the caret on it", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    const sortSeq = screen.getByRole("button", { name: "Ordenar por N.º" });
    sortSeq.focus();
    fireEvent.keyDown(sortSeq, { key: "ArrowRight", altKey: true });
    expect(headers()).toEqual(["Razón social", "Número", "N.º", "Municipio", "Cupo"]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Ordenar por N.º" })));
    expect(screen.getByRole("status").textContent).toBe("Columna N.º movida a la posición 3");
    // The keys name the shortcut on what has the caret.
    expect(screen.getByRole("button", { name: "Ordenar por N.º" }).getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowLeft Alt+ArrowRight");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", altKey: true });
    // The second Alt+← would go before the identity column: it stays at position 2.
    expect(headers()).toEqual(["Razón social", "N.º", "Número", "Municipio", "Cupo"]);
    // Without Alt the arrow keys do nothing to the columns; the identity column does not move.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    const identity = screen.getByRole("button", { name: "Ordenar por Razón social" });
    fireEvent.keyDown(identity, { key: "ArrowRight", altKey: true });
    expect(headers()).toEqual(["Razón social", "N.º", "Número", "Municipio", "Cupo"]);
  });

  it("the column chooser lists every column in order with ↑ / ↓ and visibility, and hiding keeps the order", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    fireEvent.click(screen.getByRole("button", { name: "Columnas" }));
    const chooser = screen.getByRole("group", { name: "Columnas" });
    expect(within(chooser).getAllByRole("checkbox").map((c) => c.closest("li")!.querySelector("label")!.textContent)).toEqual([
      "Razón social",
      "N.º",
      "Número",
      "Municipio",
      "Cupo",
      "Teléfono",
    ]);
    // The identity column has no arrows; the one after it cannot go up.
    expect(within(chooser).queryByRole("button", { name: "Subir Razón social" })).toBeNull();
    expect((within(chooser).getByRole("button", { name: "Subir N.º" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(chooser).getByRole("button", { name: "Bajar N.º" }));
    expect(headers()).toEqual(["Razón social", "Número", "N.º", "Municipio", "Cupo"]);
    expect(document.activeElement).toBe(within(chooser).getByRole("button", { name: "Bajar N.º" }));
    fireEvent.click(within(chooser).getByRole("button", { name: "Subir Cupo" }));
    expect(headers()).toEqual(["Razón social", "Número", "N.º", "Cupo", "Municipio"]);
    // Hide N.º, show it again: it comes back at its place.
    fireEvent.click(within(chooser).getByLabelText("N.º"));
    expect(headers()).toEqual(["Razón social", "Número", "Cupo", "Municipio"]);
    fireEvent.click(within(chooser).getByLabelText("N.º"));
    expect(headers()).toEqual(["Razón social", "Número", "N.º", "Cupo", "Municipio"]);
    await waitFor(() => expect(lastState(fetcher).columns).toEqual(["legal_name", "document_number", "seq", "credit_limit", "municipality_code"]));
    // Restablecer goes back to the first order.
    fireEvent.click(within(chooser).getByRole("button", { name: "Restablecer columnas" }));
    expect(headers()).toEqual(["Razón social", "N.º", "Número", "Municipio", "Cupo"]);
  });

  it("the export takes exactly the visible columns in their new order (rule 20)", async () => {
    const { onExport } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    fireEvent.keyDown(screen.getByRole("button", { name: "Ordenar por Cupo" }), { key: "ArrowLeft", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    expect(onExport.mock.calls[0]![1].columns).toEqual(["legal_name", "seq", "document_number", "credit_limit", "municipality_code"]);
  });

  it("a saved view keeps the order and brings it back", async () => {
    const onSave = vi.fn(async () => {});
    setup({ savedViews: { views: [], onSave } });
    await screen.findByText("Almacenes Éxito S.A.");
    fireEvent.keyDown(screen.getByRole("button", { name: "Ordenar por Municipio" }), { key: "ArrowLeft", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Guardar vista" }));
    fireEvent.change(screen.getByLabelText("Nombre de la vista"), { target: { value: "Por municipio" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Vistas" })).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const state = (onSave.mock.calls[0] as unknown as [string, boolean, SavedGridState])[2];
    expect(state.columns).toEqual(["legal_name", "seq", "municipality_code", "document_number", "credit_limit"]);
    cleanup();
    setup({ initialState: viewFromSaved(columns, JSON.parse(JSON.stringify(state))) });
    await screen.findByText("Almacenes Éxito S.A.");
    expect(headers()).toEqual(["Razón social", "N.º", "Municipio", "Número", "Cupo"]);
  });
});
