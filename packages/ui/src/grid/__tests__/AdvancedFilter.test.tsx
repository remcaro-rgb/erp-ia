// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { AdvancedFilter } from "../AdvancedFilter";
import { ConditionChips } from "../ConditionChips";
import { DataGrid } from "../DataGrid";
import type { Condition, GridColumn, GridFetcher, GridRow } from "../types";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// The advanced filter popup (design §9, prototype advOpen / advRender / advApply / condChips): conditions over every
// field with rules by type, Y / O with AND binding tighter, live results, row pick, and the applied chips.

const fields: GridColumn[] = [
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
  { field: "extra.canal", label: "Canal", type: "custom:list", kind: "enum", mode: "visible", filterable: true, sortable: true, filterOnly: true, options: [{ value: "Retail", label: "Retail" }] },
];

const rows: GridRow[] = [
  { id: "a", legal_name: "Almacenes Éxito S.A.", kind: ["customer"], credit_limit: "5000000" },
  { id: "b", legal_name: "Tostadora Pérez", kind: ["supplier"], credit_limit: "0" },
];

const condition = (n: number) => screen.getByRole("group", { name: `Condición ${n}` });

describe("AdvancedFilter", () => {
  it("builds Y / O conditions with AND precedence, lists live results and applies them", async () => {
    const preview = vi.fn(async () => ({ rows, total: 2 }));
    const onApply = vi.fn();
    const onPickRow = vi.fn();
    renderEs(
      <AdvancedFilter
        open
        onOpenChange={() => {}}
        entityLabel="Terceros"
        fields={fields}
        conditions={[]}
        onApply={onApply}
        preview={preview}
        previewColumns={fields.slice(0, 3)}
        mode="open"
        onPickRow={onPickRow}
        debounceMs={10}
      />,
    );
    expect(screen.getByRole("heading", { name: "Filtro avanzado · Terceros" })).toBeTruthy();
    // The first condition says "Donde" and starts on the first field with its type's first rule.
    expect(within(condition(1)).getByText("Donde")).toBeTruthy();
    expect((within(condition(1)).getByLabelText("Regla") as HTMLSelectElement).value).toBe("contains");
    // Masked fields are listed but cannot be chosen; admin-defined ones are marked.
    const masked = within(condition(1)).getByRole("option", { name: "Saldo (enmascarado)" }) as HTMLOptionElement;
    expect(masked.disabled).toBe(true);
    expect(within(condition(1)).getByRole("option", { name: "Canal (adicional)" })).toBeTruthy();

    fireEvent.change(within(condition(1)).getByLabelText("Valor"), { target: { value: "éxito" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Condición" }));
    fireEvent.change(within(condition(2)).getByLabelText("Campo"), { target: { value: "credit_limit" } });
    expect([...(within(condition(2)).getByLabelText("Regla") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      "=",
      "≠",
      "mayor que",
      "mayor o igual",
      "menor que",
      "menor o igual",
      "entre",
      "está vacío",
      "no está vacío",
    ]);
    fireEvent.change(within(condition(2)).getByLabelText("Regla"), { target: { value: "between" } });
    fireEvent.change(within(condition(2)).getByLabelText("Valor"), { target: { value: "1.000.000" } });
    fireEvent.change(within(condition(2)).getByLabelText("Hasta"), { target: { value: "5000000" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Condición" }));
    fireEvent.change(within(condition(3)).getByLabelText("Operador lógico"), { target: { value: "or" } });
    fireEvent.change(within(condition(3)).getByLabelText("Campo"), { target: { value: "kind" } });
    fireEvent.change(within(condition(3)).getByLabelText("Regla"), { target: { value: "eq" } });
    fireEvent.change(within(condition(3)).getByLabelText("Valor"), { target: { value: "supplier" } });

    // A line marks the new O group: (1 y 2) o 3.
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(screen.getByText(/Y se evalúa antes que O/)).toBeTruthy();
    const expected: Condition[] = [
      { field: "legal_name", op: "contains", value: "éxito" },
      { field: "credit_limit", op: "between", value: 1_000_000, value2: 5_000_000, join: "and" },
      { field: "kind", op: "eq", value: "supplier", join: "or" },
    ];
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(expected));
    const results = await screen.findByRole("region", { name: "Resultados" });
    expect(await within(results).findByText("Almacenes Éxito S.A.")).toBeTruthy();
    expect(within(results).getByText("$ 5.000.000,00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(onApply).toHaveBeenCalledWith(expected);
  });

  it("shows the applied conditions as chips with Y / O between them, each removable", () => {
    const onRemove = vi.fn();
    renderEs(
      <ConditionChips
        fields={fields}
        onRemove={onRemove}
        conditions={[
          { field: "legal_name", op: "contains", value: "éxito" },
          { field: "credit_limit", op: "between", value: 1_000_000, value2: 5_000_000, join: "and" },
          { field: "kind", op: "eq", value: "supplier", join: "or" },
        ]}
      />,
    );
    const chips = screen.getByRole("list", { name: "Condiciones activas" });
    expect(within(chips).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Razón social contiene éxito✕",
      "YCupo entre $ 1.000.000,00 y $ 5.000.000,00✕",
      "OTipo igual a Proveedor✕",
    ]);
    fireEvent.click(within(chips).getAllByRole("button", { name: "Quitar condición" })[2]!);
    expect(onRemove).toHaveBeenCalledWith(2);
  });

  it("from a grid: Aplicar writes the conditions into the grid state and shows the chips; a picked row opens the record", async () => {
    const fetcher = vi.fn<GridFetcher>(async () => ({ rows, total: 2 }));
    const onRowOpen = vi.fn();
    renderEs(<DataGrid entity="core.party" title="Terceros" columns={fields} fetcher={fetcher} onRowOpen={onRowOpen} debounceMs={10} />);
    await screen.findAllByText("Almacenes Éxito S.A.");
    fireEvent.click(screen.getByRole("button", { name: "Filtro avanzado" }));
    fireEvent.change(within(condition(1)).getByLabelText("Valor"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Condición" }));
    fireEvent.change(within(condition(2)).getByLabelText("Operador lógico"), { target: { value: "or" } });
    fireEvent.change(within(condition(2)).getByLabelText("Valor"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));

    await waitFor(() =>
      expect(fetcher.mock.calls.at(-1)![0].filters).toEqual([
        { field: "legal_name", op: "contains", value: "a" },
        { field: "legal_name", op: "contains", value: "b", join: "or" },
      ]),
    );
    const chips = screen.getByRole("list", { name: "Condiciones activas" });
    expect(within(chips).getByText("O")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filtro avanzado (2)" })).toBeTruthy();
    // A chip's ✕ removes it from the grid state.
    fireEvent.click(within(chips).getAllByRole("button", { name: "Quitar condición" })[0]!);
    await waitFor(() => expect(fetcher.mock.calls.at(-1)![0].filters).toEqual([{ field: "legal_name", op: "contains", value: "b" }]));

    // Clicking a live result applies the draft and opens the record.
    fireEvent.click(screen.getByRole("button", { name: "Filtro avanzado (1)" }));
    const results = await screen.findByRole("region", { name: "Resultados" });
    fireEvent.click(await within(results).findByText("Tostadora Pérez"));
    expect(onRowOpen).toHaveBeenCalledWith(rows[1]);
  });
});

// UI density audit quick win 8 (H8): the advanced filter works from the keyboard. Enter applies, Alt+↓ goes to the
// live results, the results are one tab stop with ↑ ↓ Home End, and Enter or Space picks a row (rule 20's "row pick").
describe("AdvancedFilter keyboard", () => {
  const render = (props: Partial<Parameters<typeof AdvancedFilter>[0]> = {}) => {
    const onApply = vi.fn();
    const onPickRow = vi.fn();
    const onOpenChange = vi.fn();
    renderEs(
      <AdvancedFilter
        open
        onOpenChange={onOpenChange}
        entityLabel="Terceros"
        fields={fields}
        conditions={[]}
        onApply={onApply}
        preview={async () => ({ rows, total: 2 })}
        previewColumns={fields.slice(0, 3)}
        mode="open"
        onPickRow={onPickRow}
        debounceMs={10}
        {...props}
      />,
    );
    return { onApply, onPickRow, onOpenChange };
  };

  it("Enter in a value box applies the conditions; Enter on a button does what the button does", async () => {
    const { onApply, onOpenChange } = render();
    const user = userEvent.setup();
    await user.click(within(condition(1)).getByLabelText("Valor"));
    await user.keyboard("norte");
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledWith([{ field: "legal_name", op: "contains", value: "norte" }]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onApply.mockClear();
    within(condition(1)).getByRole("button", { name: "Quitar condición" }).focus();
    await user.keyboard("{Enter}");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("Alt+↓ goes to the results, the rows rove with ↑ ↓ Home End, and Enter picks", async () => {
    const { onPickRow, onApply } = render();
    const user = userEvent.setup();
    const results = await screen.findByRole("region", { name: "Resultados" });
    await within(results).findByText("Almacenes Éxito S.A.");
    const resultRows = () => [...results.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row]")];
    expect(resultRows().map((r) => r.tabIndex)).toEqual([0, -1]);
    await user.click(within(condition(1)).getByLabelText("Valor"));
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(document.activeElement).toBe(resultRows()[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(resultRows()[1]);
    expect(resultRows().map((r) => r.tabIndex)).toEqual([-1, 0]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(resultRows()[0]);
    await user.keyboard("{End}{Enter}");
    expect(onPickRow).toHaveBeenCalledWith(rows[1]);
    expect(onApply).toHaveBeenCalled();
    expect(screen.getByText(/Enter aplica · Alt\+↓ va a los resultados · Enter elige/)).toBeTruthy();
  });

  it("a row that cannot be picked stays put on Enter", async () => {
    const { onPickRow } = render({ mode: "pick", blockedReason: (row) => (row.id === "a" ? "faltan datos DIAN" : null) });
    const user = userEvent.setup();
    const results = await screen.findByRole("region", { name: "Resultados" });
    await within(results).findByText("Almacenes Éxito S.A.");
    results.querySelector<HTMLTableRowElement>("tbody tr[data-row]")!.focus();
    await user.keyboard("{Enter}");
    expect(onPickRow).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown} ");
    expect(onPickRow).toHaveBeenCalledWith(rows[1]);
  });
});
