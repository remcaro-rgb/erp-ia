import { describe, expect, it } from "vitest";
import { z } from "zod";
import { auditEntityOf } from "../audit/detail";
import { defineProcess } from "../process/define";
import { defineEntity, Registry } from "../registry";
import { fieldOfKey, valueText, type ValueLabels } from "../registry/labels";

// The one label helper the audit viewer and the assistant's confirmation card share (design §22.14, rule 16): a value
// reads as the forms and grids show it, by its catalogue label (enums), the country pack's (fiscal codes), money as
// `$ 1.234.567,00` and dates in the company's zone; and the registered entity an audit entry names, whichever way the
// entry spells it (entity id, `<schema>.<table>` of a row change, or the prefix of its process).

const CATALOGUE: Record<string, string> = {
  "common.yes": "Sí",
  "common.no": "No",
  "grid.values.party_kind.customer": "Cliente",
  "grid.values.party_kind.supplier": "Proveedor",
};
const pack = { codeLabel: (table: string, code: string) => (table === "documentTypes" && code === "31" ? "31 · NIT" : undefined) };
const labels: ValueLabels = { t: (key) => CATALOGUE[key], locale: "es-419", pack, timeZone: "America/Bogota" };

describe("valueText", () => {
  it("labels enums from the catalogue and codes from the pack, keeping an unknown value as it is", () => {
    expect(valueText({ type: "enum", valuesKey: "grid.values.party_kind" }, "customer", labels)).toBe("Cliente");
    expect(valueText({ type: "json", valuesKey: "grid.values.party_kind" }, ["customer", "supplier"], labels)).toBe("Cliente, Proveedor");
    expect(valueText({ type: "text", codes: "documentTypes" }, "31", labels)).toBe("31 · NIT");
    expect(valueText({ type: "text", codes: "documentTypes" }, "99", labels)).toBe("99");
    expect(valueText({ type: "enum", valuesKey: "grid.values.party_kind" }, "employee", labels)).toBe("employee");
  });

  it("prints money as $ 1.234.567,00, booleans as Sí / No, dates in the company's zone and nothing as empty", () => {
    expect(valueText({ type: "money" }, "1234567", labels)).toBe("$ 1.234.567,00");
    expect(valueText({ type: "money" }, 50000.5, labels)).toBe("$ 50.000,50");
    expect(valueText({ type: "boolean" }, true, labels)).toBe("Sí");
    expect(valueText(undefined, false, labels)).toBe("No");
    // 15:30 UTC is 10:30 in Bogotá.
    expect(valueText({ type: "datetime" }, "2026-10-29T15:30:00Z", labels)).toBe("29/10/2026 10:30");
    expect(valueText({ type: "date" }, "2026-10-29", labels)).toBe("29/10/2026");
    expect(valueText({ type: "text" }, null, labels)).toBe("");
    expect(valueText({ type: "text" }, "", labels)).toBe("");
    expect(valueText(undefined, { a: 1 }, labels)).toBe('{"a":1}');
    expect(valueText({ type: "text" }, "Bosque QA", labels)).toBe("Bosque QA");
  });
});

describe("fieldOfKey", () => {
  it("finds a field by its column or by the camelCase key of a process input", () => {
    const fields = [{ name: "trade_name" }, { name: "legal_name" }];
    expect(fieldOfKey(fields, "tradeName")?.name).toBe("trade_name");
    expect(fieldOfKey(fields, "legal_name")?.name).toBe("legal_name");
    expect(fieldOfKey(fields, "nope")).toBeUndefined();
  });
});

describe("auditEntityOf", () => {
  const registry = new Registry();
  registry.registerEntity(
    defineEntity({
      id: "core.product_category",
      module: "core",
      schema: "core",
      table: "product_categories",
      label: "entity.core.product_category",
      displayField: "name",
      defaultSort: { field: "name", dir: "asc" },
      fields: [{ name: "name", type: "text", label: "field.core.product_category.name" }],
      processIds: { create: "core.category.create" },
    }),
  );
  registry.registerProcess(
    defineProcess({ id: "core.category.update", module: "core", kind: "update", description: "x", input: z.object({}), output: z.object({}), handler: async () => ({}) }),
  );

  it("resolves the entity id, the table of a row change and the prefix of the entity's own processes", () => {
    expect(auditEntityOf(registry, "core.product_category")?.id).toBe("core.product_category");
    expect(auditEntityOf(registry, "core.product_categories")?.id).toBe("core.product_category");
    expect(auditEntityOf(registry, "core.category")?.id).toBe("core.product_category");
    expect(auditEntityOf(registry, "kernel.roles")).toBeUndefined();
  });
});
