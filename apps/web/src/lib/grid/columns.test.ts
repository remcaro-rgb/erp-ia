import { describe, expect, it } from "vitest";
import { CORE_ENTITIES } from "@erp/module-core";
import { buildColumns } from "./columns";
import { presentationOf } from "./presentation";

// The columns of a grid page (design §9, rule 14): registry fields with the caller's modes, the presentation's
// order, value labels and pills, and the admin-defined fields the caller's roles may view.

const t = (key: string) => `«${key}»`;
const party = CORE_ENTITIES.find((e) => e.id === "core.party")!;

describe("grid columns", () => {
  it("orders the shown fields first, keeps the rest for the chooser and leaves the internal JSON out", () => {
    const columns = buildColumns(party, { modes: { credit_limit: "hidden", balance: "masked" }, extras: [], timeZone: "America/Bogota" }, presentationOf("core.party"), t, {
      documentTypes: [{ value: "31", label: "31 · NIT" }],
    });
    expect(columns.slice(0, 4).map((c) => c.field)).toEqual(["seq", "document_type", "document_number", "legal_name"]);
    expect(columns.find((c) => c.field === "extra")).toBeUndefined();
    expect(columns.find((c) => c.field === "first_name")).toMatchObject({ hiddenByDefault: true, label: "«field.core.party.first_name»" });
    expect(columns.find((c) => c.field === "credit_limit")).toMatchObject({ mode: "hidden", type: "money", kind: "number" });
    expect(columns.find((c) => c.field === "balance")).toMatchObject({ mode: "masked" });
    expect(columns.find((c) => c.field === "kind")!.options).toEqual([
      { value: "customer", label: "«grid.values.party_kind.customer»" },
      { value: "supplier", label: "«grid.values.party_kind.supplier»" },
      { value: "employee", label: "«grid.values.party_kind.employee»" },
    ]);
    expect(columns.find((c) => c.field === "invoice_ready")).toMatchObject({ kind: "enum", pills: { true: "ok", false: "danger" } });
    expect(columns.find((c) => c.field === "document_type")!.options).toEqual([{ value: "31", label: "31 · NIT" }]);
    expect(columns.find((c) => c.field === "dian_status")).toMatchObject({ display: "dian" });
  });

  it("marks the entity's display field as the identity column the grid pins first (OD-4)", () => {
    const columns = buildColumns(party, { modes: {}, extras: [], timeZone: "America/Bogota" }, presentationOf("core.party"), t);
    expect(columns.filter((c) => c.identity).map((c) => c.field)).toEqual(["legal_name"]);
    // A presentation may name another one.
    const titled = buildColumns(party, { modes: {}, extras: [], timeZone: "America/Bogota" }, { ...presentationOf("core.party"), title: "seq" }, t);
    expect(titled.filter((c) => c.identity).map((c) => c.field)).toEqual(["seq"]);
  });

  it("adds the admin-defined fields, hidden when the caller's roles may not view them", () => {
    const columns = buildColumns(
      party,
      {
        modes: {},
        extras: [
          { key: "canal", label: "Canal", type: "list", options: ["Retail", "HORECA"], viewable: true },
          { key: "secreto", label: "Secreto", type: "text", options: null, viewable: false },
        ],
        timeZone: "America/Bogota",
      },
      presentationOf("core.party"),
      t,
    );
    expect(columns.find((c) => c.field === "extra.canal")).toMatchObject({ type: "custom:list", kind: "enum", mode: "visible", hiddenByDefault: true, options: [{ value: "Retail", label: "Retail" }, { value: "HORECA", label: "HORECA" }] });
    expect(columns.find((c) => c.field === "extra.secreto")).toMatchObject({ mode: "hidden" });
  });
});
