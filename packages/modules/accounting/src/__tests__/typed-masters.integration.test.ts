import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTypedEntity, kernelModule, loadModules, Registry } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { core } from "@erp/module-core";
import { accounting } from "../index";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

// The accounting maestros on the typed-entity lifecycle (entity types spec 2026-11-02 §2.2, §5, §10.2, §12, D13, D14; Phase 2A.5
// Task 8b, migration 0043): cuentas, fuentes, the four analytic dimensions and the plantillas carry the maestro columns, are Grabado
// when created or migrated, usable on comprobantes only when active and Grabado, and their generic Grabar runs the module's update
// validation over the update process's columns only. Años fiscales and períodos are Parámetros (D14): their status is open / closed.

const ACCOUNTING_MAESTROS = [
  "accounting.account", "accounting.business_unit", "accounting.cost_center", "accounting.entry_template", "accounting.item",
  "accounting.journal", "accounting.open_auxiliary",
];

let h: AccountingHarness;
let journalId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  journalId = (await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`)[0]!.id;
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.entity_type_settings where company_id = ${h.companyId}`;
  await h.cleanup();
});

const usable = async (entity: string, id: string) =>
  (await withClaims(h.sql, h.admin.claims, (tx) => tx<{ ok: boolean }[]>`select kernel.record_usable(${entity}, ${id}::uuid) as ok`))[0]!.ok;
const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;

describe("accounting maestros on the typed lifecycle", () => {
  it("every maestro and documento table of accounting has the typed columns, the state check, the flag trigger and its entity_tables row (0043)", async () => {
    const typed = h.deps.registry.entities("accounting").filter(isTypedEntity);
    expect(typed.filter((e) => e.entityType === "maestro").map((e) => e.id).sort()).toEqual(ACCOUNTING_MAESTROS);
    expect(typed.filter((e) => e.entityType === "documento").map((e) => e.id)).toEqual(["accounting.entry", "accounting.fx_revaluation"]);
    for (const entity of typed) {
      const columns = await h.sql<{ column_name: string; is_nullable: string }[]>`
        select column_name, is_nullable from information_schema.columns where table_schema = ${entity.schema} and table_name = ${entity.table}`;
      const by = new Map(columns.map((c) => [c.column_name, c]));
      const expected = entity.entityType === "maestro" ? ["status", "requires_approval", "is_active", "deleted_at", "void_reason"] : ["status", "requires_approval", "posts", "void_reason"];
      for (const name of expected) expect(by.has(name), `${entity.table}.${name}`).toBe(true);
      expect(by.get("status")!.is_nullable, entity.table).toBe("NO");
      const [check] = await h.sql<{ def: string }[]>`
        select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = ${`${entity.schema}.${entity.table}`}::regclass and c.conname = ${`${entity.table}_status_check`}`;
      for (const state of ["draft", "saved", "pending", "rejected", "approved"]) expect(check!.def, entity.table).toContain(`'${state}'`);
      expect(check!.def.includes("'posted'"), entity.table).toBe(entity.entityType === "documento");
      const [trigger] = await h.sql`select 1 from pg_trigger where tgrelid = ${`${entity.schema}.${entity.table}`}::regclass and tgname = 'typed_copy_flags'`;
      expect(trigger, entity.table).toBeDefined();
      const [row] = await h.sql`select entity_type, table_schema, table_name from kernel.entity_tables where entity = ${entity.id}`;
      expect(row, entity.id).toMatchObject({ entity_type: entity.entityType, table_schema: entity.schema, table_name: entity.table });
      for (const name of ["status", "requires_approval"]) expect(entity.fields.some((f) => f.name === name), `${entity.id}.${name}`).toBe(true);
    }
    // Años fiscales and períodos are Parámetros: their status stays open / closed and they carry no lifecycle.
    for (const id of ["accounting.fiscal_year", "accounting.period"]) expect(h.deps.registry.entity(id).entityType).toBe("parametro");
    const [period] = await h.sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'accounting.periods'::regclass and conname = 'periods_status_check'`;
    expect(period!.def).toContain("'open'");
  });

  it("every ref field of a core or accounting table entity that points at a maestro has a kernel.references row (outside its own typed.lines)", async () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, accounting]);
    const entities = ["kernel", "core", "accounting"].flatMap((m) => registry.entities(m)).filter((e) => e.kind !== "query");
    const parentOf = new Map<string, string>();
    for (const e of entities) if (e.typed?.lines) parentOf.set(e.typed.lines.entity, e.typed.lines.parentField);
    const rows = await h.sql<{ entity: string; at: string }[]>`select entity, ref_schema || '.' || ref_table || '.' || ref_column as at from kernel."references"`;
    const registered = new Set(rows.map((r) => `${r.entity}<-${r.at}`));
    const missing: string[] = [];
    let checked = 0;
    for (const e of entities) {
      for (const f of e.fields) {
        if (f.type !== "ref" || !f.ref || f.viewExpr !== undefined) continue;
        if (registry.entity(f.ref.entity).entityType !== "maestro") continue;
        if (parentOf.get(e.id) === f.name) continue;
        checked += 1;
        const key = `${f.ref.entity}<-${e.schema}.${e.table}.${f.name}`;
        if (!registered.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(25);
  });

  it("a master created through its process is Grabado and usable; raw rows are Grabado too; an inactive or soft-deleted one is not usable", async () => {
    const created = await h.run<{ id: string }>(h.admin, "accounting.cost_center.create", { code: "TYP-1", name: "Tipado", kind: "leaf" });
    expect((await h.sql`select status, requires_approval, is_active from accounting.cost_centers where id = ${created.id}`)[0]).toMatchObject({ status: "saved", requires_approval: false, is_active: true });
    expect(await usable("accounting.cost_center", created.id)).toBe(true);
    const journal = await h.run<{ id: string }>(h.admin, "accounting.journal.create", { code: "TYP", name: "Tipada", kind: "general" });
    expect((await h.sql`select status from accounting.journals where id = ${journal.id}`)[0]).toMatchObject({ status: "saved" });
    expect(await usable("accounting.journal", journal.id)).toBe(true);
    expect((await h.sql`select status from accounting.accounts where company_id = ${h.companyId} and code = '110505'`)[0]).toMatchObject({ status: "saved" });
    expect(await usable("accounting.account", await accountId("110505"))).toBe(true);
    await h.run(h.admin, "accounting.cost_center.update", { id: created.id, isActive: false });
    expect(await usable("accounting.cost_center", created.id)).toBe(false);
  });

  it("with Requiere aprobación (Parámetros) a new master is Pendiente and not usable on a comprobante until approved", async () => {
    await h.sql`insert into kernel.entity_type_settings (company_id, entity, requires_approval) values (${h.companyId}, 'accounting.cost_center', true)
                on conflict (company_id, entity) do update set requires_approval = true`;
    try {
      const node = await h.run<{ id: string }>(h.admin, "accounting.cost_center.create", { code: "APR-1", name: "Por aprobar", kind: "leaf" });
      expect((await h.sql`select status, requires_approval from accounting.cost_centers where id = ${node.id}`)[0]).toMatchObject({ status: "pending", requires_approval: true });
      expect(await usable("accounting.cost_center", node.id)).toBe(false);
      const entry = await h.run<{ id: string }>(h.admin, "accounting.entry.create", {
        date: new Date().toISOString().slice(0, 10), description: "Con centro pendiente",
        lines: [{ accountCode: "510506", debit: 5, credit: 0, costCenterId: node.id }, { accountCode: "111005", debit: 0, credit: 5 }],
      });
      await expect(h.run(h.admin, "accounting.entry.save", { id: entry.id })).rejects.toMatchObject({ code: "maestro_not_usable", details: { field: "cost_center_id", entity: "accounting.cost_center", recordId: node.id } });
      await h.run(h.admin, "accounting.cost_center.approve", { id: node.id });
      expect(await usable("accounting.cost_center", node.id)).toBe(true);
    } finally {
      await h.sql`delete from kernel.entity_type_settings where company_id = ${h.companyId} and entity = 'accounting.cost_center'`;
    }
  });

  it("the generic Grabar of an account takes only the update process's columns and runs its checks", async () => {
    const id = await accountId("510506");
    for (const data of [{ code: "510507" }, { level: "class" }, { parent_id: newId() }, { allows_movement: false }, { access: "restricted" }, { is_opening_result: true }, { name: "ok", seq: 1 }]) {
      await expect(h.run(h.admin, "accounting.account.save", { id, data }), JSON.stringify(data)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await h.run(h.admin, "accounting.account.save", { id, data: { name: "Gastos de prueba", requires_cost_center: false } })).toMatchObject({ status: "saved" });
    expect((await h.sql`select name, requires_cost_center from accounting.accounts where id = ${id}`)[0]).toMatchObject({ name: "Gastos de prueba", requires_cost_center: false });
    await expect(h.run(h.admin, "accounting.account.save", { id, data: { name: "  " } })).rejects.toMatchObject({ code: "invalid_input" });
    // Deactivating an account with an open comprobante line is refused as by account.update.
    await h.run(h.admin, "accounting.entry.create", { date: new Date().toISOString().slice(0, 10), description: "Abierto", lines: [{ accountCode: "510506", debit: 5, credit: 0 }, { accountCode: "111005", debit: 0, credit: 5 }] });
    await expect(h.run(h.admin, "accounting.account.save", { id, data: { is_active: false } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await h.sql`select is_active from accounting.accounts where id = ${id}`)[0]).toMatchObject({ is_active: true });
  });

  it("minor 9: a maestro's form save (<entity>.update) answers the version it wrote, for «Guardar y enviar a aprobación»'s submit", async () => {
    const id = await accountId("511505");
    const out = await h.run<{ id: string; updatedAt?: string }>(h.admin, "accounting.account.update", { id, name: "Impuestos de prueba" });
    const [row] = await h.sql<{ updated_at: Date }[]>`select updated_at from accounting.accounts where id = ${id}`;
    expect(out).toEqual({ id, updatedAt: row!.updated_at.toISOString() });
    // The version it answered is the one the submit's expectedUpdatedAt check accepts.
    await expect(h.run(h.admin, "accounting.account.submit", { id, expectedUpdatedAt: "2000-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "stale_record" });
    await expect(h.run(h.admin, "accounting.account.submit", { id, expectedUpdatedAt: out.updatedAt })).rejects.not.toMatchObject({ code: "stale_record" });
  });

  it("the generic Grabar of a fuente, a dimension and a plantilla runs their update checks", async () => {
    // The manual journal cannot stop taking manual entries.
    await expect(h.run(h.admin, "accounting.journal.save", { id: journalId, data: { manual_entries: false } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.journal.save", { id: journalId, data: { next_number: 1 } })).rejects.toMatchObject({ code: "invalid_input" });
    // A dimension: no cycle, a leaf with lines does not become a group, the parent must be an active group.
    const group = await h.run<{ id: string }>(h.admin, "accounting.item.create", { code: "IT-G", name: "Grupo", kind: "group" });
    const leaf = await h.run<{ id: string }>(h.admin, "accounting.item.create", { code: "IT-L", name: "Hoja", kind: "leaf", parentId: group.id });
    await expect(h.run(h.admin, "accounting.item.save", { id: group.id, data: { parent_id: leaf.id } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.item.save", { id: group.id, data: { parent_id: group.id } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.item.save", { id: group.id, data: { kind: "leaf" } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await h.run(h.admin, "accounting.item.save", { id: leaf.id, data: { name: "Hoja renombrada" } })).toMatchObject({ status: "saved" });
    // A plantilla: the name is unique per company (D14 import key), the Fuente must exist.
    const lines = [{ accountCode: "510506", side: "debit", amount: 10 }, { accountCode: "111005", side: "credit" }];
    const first = await h.run<{ id: string }>(h.admin, "accounting.entry_template.create", { name: "Arriendo", journalId, lines });
    await expect(h.run(h.admin, "accounting.entry_template.create", { name: "Arriendo", journalId, lines })).rejects.toMatchObject({ code: "invalid_input" });
    const second = await h.run<{ id: string }>(h.admin, "accounting.entry_template.create", { name: "Servicios", journalId, lines });
    await expect(h.run(h.admin, "accounting.entry_template.save", { id: second.id, data: { name: "Arriendo" } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.entry_template.save", { id: second.id, data: { journal_id: newId() } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await h.run(h.admin, "accounting.entry_template.save", { id: second.id, data: { description: "Mensual" } })).toMatchObject({ status: "saved" });
    expect((await h.sql`select is_active, status from accounting.entry_templates where id = ${first.id}`)[0]).toMatchObject({ is_active: true, status: "saved" });
    const [unique] = await h.sql`select 1 from pg_constraint where conrelid = 'accounting.entry_templates'::regclass and conname = 'entry_templates_company_id_name_key'`;
    expect(unique).toBeDefined();
  });

  it("Eliminar: a referenced master is refused with the Activo = no hint; an unused one is soft-deleted and leaves the views", async () => {
    await expect(h.run(h.admin, "accounting.account.delete", { id: await accountId("510506") })).rejects.toMatchObject({ code: "invalid_state", details: { reason: "referenced", messageKey: "errors.record_referenced" } });
    // The parent of other accounts is referenced by them.
    await expect(h.run(h.admin, "accounting.account.delete", { id: await accountId("5105") })).rejects.toMatchObject({ code: "invalid_state", details: { reason: "referenced" } });
    await expect(h.run(h.admin, "accounting.journal.delete", { id: journalId })).rejects.toMatchObject({ code: "invalid_state", details: { reason: "referenced" } });
    const spare = await h.run<{ id: string }>(h.admin, "accounting.business_unit.create", { code: "BU-X", name: "Sin uso", kind: "leaf" });
    expect(await h.run(h.admin, "accounting.business_unit.delete", { id: spare.id })).toMatchObject({ deleted: true });
    const visible = await withClaims(h.sql, h.admin.claims, (tx) => tx`select 1 from accounting.v_business_units where id = ${spare.id}`);
    expect(visible).toHaveLength(0);
    await expect(h.run(h.admin, "accounting.business_unit.update", { id: spare.id, name: "Otra" })).rejects.toMatchObject({ code: "not_found" });
    expect(await usable("accounting.business_unit", spare.id)).toBe(false);
  });

  it("the TEMPORARY typedValidatePending allowance is gone: every accounting typed entity with an update process has a validate hook", () => {
    expect((accounting as unknown as Record<string, unknown>).typedValidatePending).toBeUndefined();
    const own = new Set(accounting.processes.map((p) => p.id));
    for (const entity of accounting.entities.filter(isTypedEntity)) {
      if (own.has(`${entity.id}.update`)) expect(accounting.typedHooks?.[entity.id]?.validate, entity.id).toBeTypeOf("function");
    }
  });
});
