import { describe, expect, it } from "vitest";
import { codeFilter } from "../code-filter";
import { stateFilters, toGridState, initialView } from "../grid-model";
import { savedStateOf } from "../saved-views";
import type { GridColumn } from "../types";

// Rule 20: every visible column filters by what the user sees. A coded column (DANE municipality, document type…)
// stores the code and shows the label; a text rule typed by the user becomes a code set before it reaches the server.

const municipality: GridColumn = {
  field: "municipality_code",
  label: "Municipio",
  type: "text",
  kind: "text",
  mode: "visible",
  filterable: true,
  sortable: true,
  options: [
    { value: "05001", label: "Medellín" },
    { value: "11001", label: "Bogotá, D.C." },
    { value: "05088", label: "Bello" },
    { value: "76001", label: "Cali" },
    // DANE has about 1100: more than a select holds, so the filter row offers a text box.
    ...Array.from({ length: 70 }, (_, i) => ({ value: `99${String(i).padStart(3, "0")}`, label: `Pueblo ${i}` })),
  ],
};
const name: GridColumn = { field: "name", label: "Nombre", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true };
const documentType: GridColumn = { ...municipality, field: "document_type", label: "Tipo de documento", options: [{ value: "31", label: "31 · NIT" }, { value: "13", label: "13 · Cédula de ciudadanía" }] };

describe("codeFilter", () => {
  it("turns contains / starts / ends / eq on a label into the set of matching codes, without accents or case", () => {
    expect(codeFilter(municipality, { field: "municipality_code", op: "contains", value: "Medell" })).toEqual({ field: "municipality_code", op: "in", value: ["05001"] });
    expect(codeFilter(municipality, { field: "municipality_code", op: "contains", value: "MEDELLIN" })).toEqual({ field: "municipality_code", op: "in", value: ["05001"] });
    expect(codeFilter(municipality, { field: "municipality_code", op: "contains", value: "bogota" })).toEqual({ field: "municipality_code", op: "in", value: ["11001"] });
    expect(codeFilter(municipality, { field: "municipality_code", op: "starts", value: "b" })).toEqual({ field: "municipality_code", op: "in", value: ["11001", "05088"] });
    expect(codeFilter(municipality, { field: "municipality_code", op: "ends", value: "li" })).toEqual({ field: "municipality_code", op: "in", value: ["76001"] });
    expect(codeFilter(municipality, { field: "municipality_code", op: "eq", value: "cali" })).toEqual({ field: "municipality_code", op: "in", value: ["76001"] });
    expect(codeFilter(documentType, { field: "document_type", op: "contains", value: "cédula" })).toEqual({ field: "document_type", op: "in", value: ["13"] });
  });

  it("still matches the raw code", () => {
    expect(codeFilter(municipality, { field: "municipality_code", op: "contains", value: "05001" })).toEqual({ field: "municipality_code", op: "in", value: ["05001"] });
    expect(codeFilter(municipality, { field: "municipality_code", op: "starts", value: "05" })).toEqual({ field: "municipality_code", op: "in", value: ["05001", "05088"] });
    expect(codeFilter(documentType, { field: "document_type", op: "eq", value: "31" })).toEqual({ field: "document_type", op: "in", value: ["31"] });
  });

  it("negative rules become `nin` over the codes the positive rule matches", () => {
    expect(codeFilter(municipality, { field: "municipality_code", op: "ncontains", value: "medellín", join: "or" })).toEqual({ field: "municipality_code", op: "nin", value: ["05001"], join: "or" });
    expect(codeFilter(municipality, { field: "municipality_code", op: "neq", value: "Bello" })).toEqual({ field: "municipality_code", op: "nin", value: ["05088"] });
  });

  it("no match selects nothing (an empty set), never every row", () => {
    expect(codeFilter(municipality, { field: "municipality_code", op: "contains", value: "zzz" })).toEqual({ field: "municipality_code", op: "in", value: [] });
  });

  it("leaves alone columns without options, rules without a text value and the empty tests", () => {
    const f = { field: "name", op: "contains" as const, value: "Medell" };
    expect(codeFilter(name, f)).toBe(f);
    const empty = { field: "municipality_code", op: "is_null" as const };
    expect(codeFilter(municipality, empty)).toBe(empty);
    expect(codeFilter(undefined, f)).toBe(f);
  });
});

describe("the grid's server state", () => {
  const columns = [name, municipality];

  it("translates the filter row and the advanced conditions alike (Y / O kept)", () => {
    const view = {
      ...initialView(columns),
      columnFilters: { municipality_code: "Medell" },
      conditions: [
        { field: "municipality_code", op: "contains" as const, value: "Bogotá" },
        { field: "municipality_code", op: "contains" as const, value: "Medellín", join: "or" as const },
      ],
    };
    expect(stateFilters(columns, view)).toEqual([
      { field: "municipality_code", op: "in", value: ["05001"] },
      { field: "municipality_code", op: "in", value: ["11001"], join: "and" },
      { field: "municipality_code", op: "in", value: ["05001"], join: "or" },
      { field: "municipality_code", op: "in", value: ["05001"], join: "and" },
    ]);
    expect(toGridState(columns, view).filters).toEqual(stateFilters(columns, view));
  });

  it("a saved view keeps the text as typed, so its chips show the label", () => {
    const view = { ...initialView(columns), columnFilters: { municipality_code: "Medell" } };
    expect(savedStateOf(columns, view).filters).toEqual([{ field: "municipality_code", op: "contains", value: "Medell" }]);
  });
});
