import { describe, expect, it } from "vitest";
import { CORE_ENTITIES } from "@erp/module-core";
import { ACCOUNTING_ENTITIES } from "@erp/module-accounting";
import { SALES_ENTITIES } from "@erp/module-sales";
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

  it("carries each reference's target, and whether the viewer may open it, to the cell that links it (rule 21)", () => {
    const product = CORE_ENTITIES.find((e) => e.id === "core.product")!;
    const columns = buildColumns(product, { modes: {}, extras: [], timeZone: "America/Bogota" }, presentationOf("core.product"), t, {}, new Set(["core.party"]));
    expect(columns.find((c) => c.field === "supplier_id")).toMatchObject({ ref: { entity: "core.party", display: "legal_name" }, linkable: true });
    expect(columns.find((c) => c.field === "category_id")).toMatchObject({ ref: { entity: "core.product_category", display: "name" } });
    expect(columns.find((c) => c.field === "category_id")!.linkable).toBeUndefined();
    expect(columns.find((c) => c.field === "sku")!.ref).toBeUndefined();
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

  it("a comprobante's state column is marked «Revertido» (red) when the comprobante has a reversal", () => {
    const entry = ACCOUNTING_ENTITIES.find((e) => e.id === "accounting.entry")!;
    const columns = buildColumns(entry, { modes: {}, extras: [], timeZone: "America/Bogota" }, presentationOf("accounting.entry"), t, {});
    expect(columns.find((c) => c.field === "status")).toMatchObject({ marked: { field: "reversed_by_id", whenValue: "posted", label: "«accounting.values.entry_status.reversed»", tone: "danger" } });
    // The filter keeps the stored states: nothing is stored as "reversed".
    expect(columns.find((c) => c.field === "status")!.options!.map((o) => o.value)).not.toContain("reversed");
  });
});

// Order owner isolation (plan 2B Task 39): a pedido the caller cannot read is never named, shown as an id or linked from the grids.
describe("grids that name a pedido (Task 39)", () => {
  const access = { modes: {}, extras: [], timeZone: "America/Bogota" };
  const entityOf = (id: string) => SALES_ENTITIES.find((e) => e.id === id)!;
  const tt = (key: string) => `«${key}»`;

  it("gives the deliveries' and returns' pedido column the text an unreadable pedido reads as", () => {
    for (const id of ["sales.delivery", "sales.return"]) {
      const columns = buildColumns(entityOf(id), access, presentationOf(id), tt, {}, new Set(["sales.order"]));
      expect(columns.find((c) => c.field === "order_id"), id).toMatchObject({ unavailable: "«sales.view.order_unavailable»" });
    }
    const orders = buildColumns(entityOf("sales.order"), access, presentationOf("sales.order"), tt);
    expect(orders.find((c) => c.field === "party_id")!.unavailable).toBeUndefined();
  });

  it("names the salesperson columns by the members table (the pedidos' and the deliveries' pedido owner)", () => {
    const members = [{ value: "u1", label: "Ana" }];
    const orders = buildColumns(entityOf("sales.order"), access, presentationOf("sales.order"), tt, { members });
    expect(orders.find((c) => c.field === "owner_id")!.options).toEqual(members);
    const deliveries = buildColumns(entityOf("sales.delivery"), access, presentationOf("sales.delivery"), tt, { members });
    expect(deliveries.find((c) => c.field === "order_owner_id")!.options).toEqual(members);
  });
});
