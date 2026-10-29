// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { ProductForm } from "../ProductForm";
import type { CategoryOption, ProductTables } from "../product-form-model";
import type { SaveRecord } from "../save-model";

afterEach(cleanup);

// The product form's search boxes (unit of measure, category), its computed fields and the DIAN hints switch.

const tables: ProductTables = {
  idSchemes: [{ code: "999", name: "Estándar de adopción del contribuyente", kind: "own", length: 0, standardCodeLabel: "Código" }],
  uoms: [
    { code: "KGM", name: "Kilogramo" },
    { code: "LTR", name: "Litro" },
    { code: "94", name: "Unidad" },
  ],
  ivaRates: [
    { code: "19", name: "19 %" },
    { code: "5", name: "5 %" },
  ],
  incRates: [{ code: "8", name: "8 %" }],
  otherTaxes: [],
  priceTypes: [],
  limits: { sku: 20, description: 450, brand: 100, model: 100 },
};
const categories: CategoryOption[] = [
  { id: "cat-1", name: "Café", ivaRate: "5", incRate: null, otherTaxes: [], defaultUom: "KGM", active: true },
  { id: "cat-2", name: "Lácteos", ivaRate: "19", incRate: null, otherTaxes: [], defaultUom: "LTR", active: true },
];
const suppliers = [
  { id: "s1", legal_name: "Tostadora Andina S.A.S.", document_number: "900111222", dian_status: "complete", dian_missing: [], invoice_ready: true, is_active: true },
  { id: "s2", legal_name: "Café Montaña Ltda.", document_number: "800333444", dian_status: "complete", dian_missing: [], invoice_ready: true, is_active: true },
];
const supplier = { fetcher: vi.fn(async () => ({ rows: suppliers, total: 2 })) as never, fields: [], entityLabel: "Terceros", label: null };

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

const setup = (record: (Record<string, unknown> & { id: string }) | null = null) => {
  const save = vi.fn<SaveRecord>(async () => ({ ok: true, id: "0192f000-0000-7000-8000-000000000001" }));
  renderEs(<ProductForm record={record} tables={tables} categories={categories} modes={{}} save={save} supplier={supplier} />);
  return { save };
};

describe("ProductForm", () => {
  it("the unit and the category are typeahead boxes; the unit follows the category and is saved by code", async () => {
    const { save } = setup();
    fireEvent.change(screen.getByLabelText(/^Código interno/), { target: { value: "CAF-1" } });
    const category = screen.getByRole("combobox", { name: /^Categoría/ }) as HTMLInputElement;
    fireEvent.change(category, { target: { value: "lacteos" } });
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Lácteos")]);
    fireEvent.keyDown(category, { key: "Enter" });
    expect(category.value).toContain("Lácteos");
    // A new product takes its category's unit.
    const uom = screen.getByRole("combobox", { name: /^Unidad de medida/ }) as HTMLInputElement;
    expect(uom.value).toBe("Litro");
    fireEvent.change(uom, { target: { value: "kil" } });
    fireEvent.keyDown(uom, { key: "Enter" });
    expect(uom.value).toBe("Kilogramo");
    fireEvent.change(screen.getByLabelText(/^Descripción/), { target: { value: "Café" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ uomCode: "KGM", categoryId: "cat-2" });
  });

  it("Enter walks into the supplier lookup and on again without picking anyone; typing or an arrow first does pick", async () => {
    const { save } = setup();
    const model = screen.getByLabelText(/^Modelo/) as HTMLInputElement;
    const lookup = screen.getByRole("combobox", { name: "Proveedor principal" }) as HTMLInputElement;
    const uom = screen.getByRole("combobox", { name: /^Unidad de medida/ });
    model.focus();
    fireEvent.keyDown(model, { key: "Enter" });
    expect(document.activeElement).toBe(lookup);
    // Its list opens on focus; Enter is still "next field" and picks nothing.
    fireEvent.focus(lookup);
    expect(await screen.findByRole("option", { name: /Tostadora Andina/ })).toBeTruthy();
    fireEvent.keyDown(lookup, { key: "Enter" });
    expect(document.activeElement).toBe(uom);
    expect(lookup.value).toBe("");
    // An arrow first: it points at the second row and Enter picks that one.
    lookup.focus();
    fireEvent.focus(lookup);
    await screen.findByRole("option", { name: /Tostadora Andina/ });
    fireEvent.keyDown(lookup, { key: "ArrowDown" });
    fireEvent.keyDown(lookup, { key: "Enter" });
    expect(lookup.value).toBe("Café Montaña Ltda.");
    // Typing first: Enter picks the highlighted row.
    fireEvent.change(lookup, { target: { value: "tost" } });
    await waitFor(() => expect(lookup.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(lookup, { key: "Enter" });
    expect(lookup.value).toBe("Tostadora Andina S.A.S.");
    fireEvent.change(screen.getByLabelText(/^Código interno/), { target: { value: "CAF-1" } });
    fireEvent.change(screen.getByLabelText(/^Descripción/), { target: { value: "Café" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ supplierId: "s1" });
  });

  it("the unit shows its DIAN code only with the hints on", () => {
    setup({ id: "p1", sku: "X", description: "X", kind: "good", uom_code: "KGM" });
    const uom = screen.getByRole("combobox", { name: /^Unidad de medida/ }) as HTMLInputElement;
    expect(uom.value).toBe("Kilogramo");
    expect(screen.queryByText(/UN\/ECE/)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Ver códigos DIAN" }));
    expect((screen.getByRole("combobox", { name: /^Unidad de medida/ }) as HTMLInputElement).value).toBe("KGM · Kilogramo");
    expect(screen.getByText("@unitCode UN/ECE Rec. 20")).toBeTruthy();
    // The category's codes are internal ids: never shown, never searched.
    const category = screen.getByRole("combobox", { name: /^Categoría/ });
    fireEvent.change(category, { target: { value: "cat-" } });
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Sin coincidencias"]);
  });

  it("the margin and the own standard code are read-only and copyable", async () => {
    setup({ id: "p1", sku: "CAF-1", description: "Café", kind: "good", id_scheme: "999", list_price: 100, standard_cost: 60 });
    const margin = screen.getByLabelText("Margen", { selector: "input" }) as HTMLInputElement;
    expect(margin.readOnly).toBe(true);
    expect(margin.disabled).toBe(false);
    expect(margin.value).toBe("40 %");
    fireEvent.click(screen.getByRole("button", { name: "Copiar Margen" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("40 %"));
    const code = screen.getByLabelText(/^Código estándar/, { selector: "input" }) as HTMLInputElement;
    expect(code.readOnly).toBe(true);
    expect(code.value).toBe("CAF-1");
  });
});
