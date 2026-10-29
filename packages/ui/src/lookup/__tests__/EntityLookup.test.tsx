// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { EntityLookup } from "../EntityLookup";
import type { GridColumn, GridFetcher, GridRow } from "../../grid/types";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// The lookup control (design §9, §5.17, prototype lookupHtml / lkSearch / lkPick / lkKey): autocomplete over the
// entity's searchable fields through the grid route, DIAN and invoice-ready pills, `forInvoice` disabling the rows
// that cannot go on an invoice with their reasons, the keyboard, and the advanced filter behind the magnifier.

const fields: GridColumn[] = [
  { field: "legal_name", label: "Razón social", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true },
  { field: "document_number", label: "Número de documento", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true, display: "mono" },
];

const ready: GridRow = { id: "a", legal_name: "Café del Norte S.A.S.", document_number: "900373115", dian_status: "complete", dian_missing: [], invoice_ready: true, is_active: true };
const pending: GridRow = { id: "b", legal_name: "Cafetería La 14", document_number: "800123456", dian_status: "missing: 2", dian_missing: ["Dirección", "Correo de facturación"], invoice_ready: false, is_active: true };

const setup = (props: Partial<Parameters<typeof EntityLookup>[0]> = {}) => {
  const fetcher = vi.fn<GridFetcher>(async () => ({ rows: [ready, pending], total: 2 }));
  const onPick = vi.fn();
  renderEs(
    <EntityLookup
      aria-label="Proveedor"
      entityLabel="Terceros"
      fetcher={fetcher}
      fields={fields}
      describe={(row) => ({ label: String(row.legal_name), sub: String(row.document_number) })}
      onPick={onPick}
      baseFilters={[{ field: "kind", op: "eq", value: "supplier" }]}
      debounceMs={10}
      {...props}
    />,
  );
  return { fetcher, onPick, input: screen.getByRole("combobox", { name: "Proveedor" }) as HTMLInputElement };
};

describe("EntityLookup", () => {
  it("searches the searchable fields through the grid route as the user types", async () => {
    const { fetcher, input } = setup();
    fireEvent.change(input, { target: { value: "caf" } });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls.at(-1)![0]).toEqual({ filters: [{ field: "kind", op: "eq", value: "supplier" }], sort: [], page: 1, pageSize: 8, search: "caf" });
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Café del Norte S.A.S.900373115Completo", "Cafetería La 14800123456Faltan 2"]);
  });

  it("forInvoice disables the rows that are not invoice-ready, with the reasons, and picks with the keyboard", async () => {
    const { input, onPick } = setup({ forInvoice: true });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "caf" } });
    const list = await screen.findByRole("listbox");
    const [first, second] = within(list).getAllByRole("option");
    expect(first!.getAttribute("aria-disabled")).toBeNull();
    expect(within(first!).getByText("facturable")).toBeTruthy();
    expect(second!.getAttribute("aria-disabled")).toBe("true");
    expect(second!.getAttribute("title")).toBe("No se puede usar en facturas: Faltan datos DIAN: Dirección, Correo de facturación");
    expect(within(second!).getByText("no facturable")).toBeTruthy();

    // A disabled row is never picked; the reason is announced instead.
    fireEvent.mouseDown(second!);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Faltan datos DIAN");

    // Arrows move the highlight (wrapping), Enter on a disabled row does nothing, on a ready one picks it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(second!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(first!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(ready);
    expect(input.value).toBe("Café del Norte S.A.S.");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("without forInvoice every row can be picked; Escape closes the list", async () => {
    const { input, onPick } = setup();
    fireEvent.change(input, { target: { value: "caf" } });
    const list = await screen.findByRole("listbox");
    const second = within(list).getAllByRole("option")[1]!;
    expect(second.getAttribute("aria-disabled")).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(input, { target: { value: "cafe" } });
    fireEvent.mouseDown(within(await screen.findByRole("listbox")).getAllByRole("option")[1]!);
    expect(onPick).toHaveBeenCalledWith(pending);
  });

  it("the magnifier opens the advanced filter; a picked result fills the field, a non-invoiceable one cannot be picked", async () => {
    const { onPick, input } = setup({ forInvoice: true });
    fireEvent.click(screen.getByRole("button", { name: "Filtro avanzado" }));
    const results = await screen.findByRole("region", { name: "Resultados" });
    expect(screen.getByText(/clic en una fila para seleccionarla en el campo/)).toBeTruthy();
    fireEvent.click(await within(results).findByText("Cafetería La 14"));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(within(results).getByText("Café del Norte S.A.S."));
    expect(onPick).toHaveBeenCalledWith(ready);
    await waitFor(() => expect(input.value).toBe("Café del Norte S.A.S."));
  });

  it("shows the current value and clears it", () => {
    const { input, onPick } = setup({ value: { id: "a", label: "Café del Norte S.A.S." } });
    expect(input.value).toBe("Café del Norte S.A.S.");
    fireEvent.click(screen.getByRole("button", { name: "Quitar la selección" }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("links the chosen record to its page beside the magnifier when the viewer may open it (rule 21)", () => {
    setup({ value: { id: "a", label: "Café del Norte S.A.S." }, href: "/r/core.party/a" });
    const link = screen.getByRole("link", { name: "Abrir Café del Norte S.A.S." });
    expect(link.getAttribute("href")).toBe("/r/core.party/a");
    cleanup();
    // No link without a choice, nor when the viewer may not open the record.
    setup({ value: null, href: "/r/core.party/a" });
    expect(screen.queryByRole("link")).toBeNull();
    cleanup();
    setup({ value: { id: "a", label: "Café del Norte S.A.S." }, href: null });
    expect(screen.queryByRole("link")).toBeNull();
  });
});
