import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineProcess } from "../process/define";
import { defineEntity, registry, Registry, type EntityDef } from "../registry";
import { maskedViewSql } from "../security/masked-views";

const party: EntityDef = {
  id: "core.party",
  module: "core",
  schema: "core",
  table: "parties",
  label: "entity.core.party",
  entityType: "maestro",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [
    { name: "name", type: "text", label: "field.name", required: true },
    { name: "credit_limit", type: "money", label: "field.credit_limit", sensitivity: "confidential" },
  ],
};

const proc = (id: string, module: string) =>
  defineProcess({ id, module, kind: "consult", description: "prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) });

describe("entity registry", () => {
  it("defineEntity validates fields and registers", () => {
    const e = defineEntity(party);
    registry.registerEntity(e);
    expect(registry.entity("core.party").fields).toHaveLength(2);
    expect(() => registry.registerEntity(e)).toThrow(/already registered/);
  });

  it("requires an entityType on table entities and refuses one on query entities (entity types, spec 2.1)", () => {
    const untyped = { ...party, entityType: undefined };
    expect(() => defineEntity(untyped)).toThrow("entity core.party: entityType is required");
    expect(() => defineEntity({ ...untyped, kind: "table" })).toThrow("entity core.party: entityType is required");
    expect(() => defineEntity({ ...untyped, kind: "query" })).not.toThrow();
    expect(() => defineEntity({ ...party, kind: "query" })).toThrow("entity core.party: query entities carry no entityType");
    expect(() => defineEntity({ ...party, entityType: "otro" as never })).toThrow(/entityType must be one of/);
    expect(defineEntity({ ...party, entityType: "documento" }).entityType).toBe("documento");
  });

  it("accepts the five roles and gives lines, parametro and sistema no lifecycle block (D13)", () => {
    for (const role of ["maestro", "documento", "lines", "parametro", "sistema"] as const) {
      expect(defineEntity({ ...party, entityType: role }).entityType).toBe(role);
    }
    for (const role of ["lines", "parametro", "sistema"] as const) {
      expect(() => defineEntity({ ...party, entityType: role, typed: {} })).toThrow(`entity core.party: ${role} entities carry no typed block`);
    }
  });

  it("validates the typed block: approvalFields, lines and numbering", () => {
    const doc = { ...party, entityType: "documento" as const };
    expect(() => defineEntity({ ...doc, typed: { approvalFields: ["nope"] } })).toThrow("entity core.party: typed.approvalFields nope is not a field");
    expect(() => defineEntity({ ...doc, typed: { lines: { entity: "core.party", parentField: "nope" } } })).toThrow("entity core.party: typed.lines.parentField nope is not a field");
    expect(() => defineEntity({ ...doc, typed: { lines: { entity: "bad", parentField: "name" } } })).toThrow(/typed.lines.entity/);
    expect(() => defineEntity({ ...doc, typed: { numbering: "sometimes" as never } })).toThrow(/typed.numbering/);
    expect(() => defineEntity({ ...party, typed: { numbering: "on_post" } })).toThrow(/typed.numbering is for documento/);
    expect(defineEntity({ ...party, typed: { lines: { entity: "core.line", parentField: "name" } } }).typed?.lines?.entity).toBe("core.line");
    const ok = defineEntity({ ...doc, typed: { approvalFields: ["name"], lines: { entity: "core.line", parentField: "name" }, numbering: "on_post" } });
    expect(ok.typed).toEqual({ approvalFields: ["name"], lines: { entity: "core.line", parentField: "name" }, numbering: "on_post" });
    expect(() => defineEntity({ ...party, kind: "query", entityType: undefined, typed: {} })).toThrow(/query entities carry no typed/);
  });

  it("maskedViewSql wraps every field in a visibility case", () => {
    const sql = maskedViewSql(defineEntity(party));
    expect(sql).toContain("create or replace view core.v_parties");
    expect(sql).toContain("security_invoker = true");
    expect(sql).toContain("kernel.field_visible('core.party', 'credit_limit')");
    expect(sql).toContain("kernel.field_visible('core.party', 'name')");
    // Wrapped in a scalar subquery so it is evaluated once per statement, not per row.
    expect(sql).toContain("case when (select kernel.field_visible('core.party', 'credit_limit')) then");
    expect(sql).toContain("from core.parties;");
    expect(sql).toContain("grant select on core.v_parties to authenticated;");
  });

  it("maskedViewSql never masks id, company_id and audit columns, and selects id and company_id once", () => {
    const sql = maskedViewSql(
      defineEntity({
        ...party,
        fields: [
          { name: "id", type: "uuid", label: "field.id" },
          { name: "created_at", type: "datetime", label: "field.created_at" },
          ...party.fields,
        ],
      }),
    );
    expect(sql).not.toContain("field_visible('core.party', 'id')");
    expect(sql).not.toContain("field_visible('core.party', 'created_at')");
    expect(sql.match(/"id"/g)).toHaveLength(1);
    expect(sql).toContain(`  "company_id"`);
    expect(sql).toContain(`  "created_at"`);
  });

  it("applies field defaults, searchable being false", () => {
    const [name] = defineEntity(party).fields;
    expect(name).toMatchObject({
      required: true,
      sensitivity: "normal",
      sortable: true,
      filterable: true,
      exportable: true,
      searchable: false,
    });
    const searchable = defineEntity({
      ...party,
      fields: [{ name: "name", type: "text", label: "field.name", searchable: true, sortable: false }],
    }).fields[0];
    expect(searchable).toMatchObject({ searchable: true, sortable: false });
  });

  it("accepts a list field (a text[] column) of type text, enum or json", () => {
    const fields = defineEntity({
      ...party,
      fields: [
        { name: "name", type: "text", label: "field.name", list: true },
        { name: "kind", type: "enum", label: "field.kind", enumValues: ["customer"], list: true },
        { name: "codes", type: "json", label: "field.codes", list: true },
      ],
    }).fields;
    expect(fields.map((f) => f.list)).toEqual([true, true, true]);
  });

  it("rejects invalid declarations", () => {
    const text = (name: string) => ({ name, type: "text" as const, label: `field.${name}` });
    expect(() => defineEntity({ ...party, fields: [text("name"), text("name")] })).toThrow(/duplicate field name/);
    expect(() => defineEntity({ ...party, displayField: "nope" })).toThrow(/displayField nope/);
    expect(() => defineEntity({ ...party, defaultSort: { field: "nope", dir: "asc" } })).toThrow(/defaultSort.field nope/);
    expect(() => defineEntity({ ...party, fields: [text("name"), { name: "kind", type: "enum", label: "field.kind" }] })).toThrow(
      /enum fields need enumValues/,
    );
    expect(() =>
      defineEntity({ ...party, fields: [text("name"), { name: "owner", type: "ref", label: "field.owner" }] }),
    ).toThrow(/ref fields need ref/);
    expect(() => defineEntity({ ...party, fields: [text("name"), { name: "total", type: "number", label: "field.total", list: true }] })).toThrow(
      /list only applies to text, enum and json fields/,
    );
    expect(() =>
      defineEntity({
        ...party,
        fields: [text("name"), { name: "owner", type: "ref", label: "field.owner", ref: { entity: "Party", display: "name" } }],
      }),
    ).toThrow(/not an entity id/);
    expect(() => defineEntity({ ...party, fields: [text("name"), text("Bad Name")] })).toThrow(/invalid field name/);
    expect(() => defineEntity({ ...party, table: "parties; drop table x" })).toThrow(/invalid table/);
    expect(() => defineEntity({ ...party, id: "party" })).toThrow(/module.name/);
    expect(
      defineEntity({
        ...party,
        fields: [text("name"), { name: "owner", type: "ref", label: "field.owner", ref: { entity: "core.party", display: "name" } }],
      }).fields,
    ).toHaveLength(2);
  });

  it("lists entities, processes and modules and filters them by module", () => {
    const r = new Registry();
    r.registerEntity(defineEntity(party));
    r.registerEntity(defineEntity({ ...party, id: "sales.order", module: "sales", schema: "sales", table: "orders" }));
    expect(r.entities().map((e) => e.id)).toEqual(["core.party", "sales.order"]);
    expect(r.entities("sales").map((e) => e.id)).toEqual(["sales.order"]);
    expect(() => r.entity("nope.nope")).toThrow(/unknown entity/);

    r.registerProcess(proc("core.party.create", "core"));
    r.registerProcess(proc("sales.order.confirm", "sales"));
    expect(r.process("sales.order.confirm").module).toBe("sales");
    expect(r.processes().map((p) => p.id)).toEqual(["core.party.create", "sales.order.confirm"]);
    expect(r.processes({ module: "core" }).map((p) => p.id)).toEqual(["core.party.create"]);
    expect(() => r.registerProcess(proc("core.party.create", "core"))).toThrow(/already registered/);
    expect(() => r.process("nope")).toThrow(/unknown process/);

    const core = { id: "core", version: "1", dependsOn: [], entities: [], processes: [], features: [], events: { emits: [], consumes: {} }, navigation: [] };
    r.registerModule(core);
    expect(r.modules()).toEqual([core]);
    expect(r.module("core")).toBe(core);
    expect(() => r.module("nope")).toThrow(/unknown module/);
    expect(() => r.registerModule(core)).toThrow(/already registered/);
  });
});
