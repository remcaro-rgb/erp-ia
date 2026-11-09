import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers, defineModule, runProcess, type DefaultPostingRule, type ModuleDef } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "./helpers";
import invoiceIssued from "../rules/defaults/invoice-issued.json" with { type: "json" };
import invoiceVoided from "../rules/fixtures/invoice-voided-rule.json" with { type: "json" };
import noteIssued from "../rules/defaults/note-credit-issued.json" with { type: "json" };
import { COSTING_POSTING_RULES } from "../../../costing/src/rules";
import { INVENTORY_POSTING_RULES } from "../../../inventory/src/rules";

// Posting rules ship in the module manifests (plan 2B Task 1, accounting design §5.4). Only core and accounting exist, so the test
// registers an `invoicing` stand-in carrying three rules (the 2A templates under test names) and proves the sync over it.

const rule = (base: unknown, name: string): DefaultPostingRule => ({ ...(base as DefaultPostingRule), name });
const invoicing: ModuleDef = defineModule({
  id: "invoicing",
  version: "0.0.1",
  dependsOn: ["core"],
  entities: [],
  processes: [],
  features: [],
  events: { emits: [], consumes: {} },
  navigation: [],
  postingRules: [
    rule(invoiceIssued, "Factura de prueba emitida"),
    rule(noteIssued, "Nota de prueba emitida"),
    rule(invoiceVoided, "Factura de prueba anulada"),
  ],
});
// Stand-ins for the two owners of the rules moved out of accounting's defaults (Task 50.14): each ships exactly its real rules.
const inventoryOwner: ModuleDef = defineModule({
  id: "inventory", version: "0.0.1", dependsOn: ["core"], entities: [], processes: [], features: [], events: { emits: [], consumes: {} }, navigation: [],
  postingRules: INVENTORY_POSTING_RULES,
});
const costingOwner: ModuleDef = defineModule({
  id: "costing", version: "0.0.1", dependsOn: ["core", "inventory"], entities: [], processes: [], features: [], events: { emits: [], consumes: {} }, navigation: [],
  postingRules: COSTING_POSTING_RULES,
});
const NAMES = ["Factura de prueba anulada", "Factura de prueba emitida", "Nota de prueba emitida"];

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness({ extraModules: [invoicing, inventoryOwner, costingOwner] });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

/** The process as an event consumer runs it: origin event, system admin. */
const sync = () => runProcess(h.deps, { claims: h.admin.claims, origin: "event" }, "accounting.posting_rule.sync", {}) as Promise<{ inserted: number; activated: number; deactivated: number }>;
const rulesOf = (moduleId: string) => h.sql<{ id: string; name: string; is_active: boolean; is_modified: boolean; template: { description?: string } }[]>`
  select id, name, is_active, is_modified, template from accounting.posting_rules where company_id = ${h.companyId} and module = ${moduleId} order by name`;

describe("accounting.posting_rule.sync", () => {
  it("chart.seed installed the rules of every module enabled for the company, invoicing's three included", async () => {
    const rules = await rulesOf("invoicing");
    expect(rules.map((r) => r.name)).toEqual(NAMES);
    expect(rules.every((r) => r.is_active && !r.is_modified)).toBe(true);
    // Six of design §5.4 (invoice-voided retired, Task 52.5) plus the two of the advance application (plan 2B.2 Task 36, byte for byte payments' own).
    expect((await rulesOf("accounting")).length).toBe(8);
  });

  it("is event-only (a user is forbidden) and a second run changes nothing", async () => {
    await expect(h.run(h.admin, "accounting.posting_rule.sync", {})).rejects.toMatchObject({ code: "forbidden" });
    const before = await h.sql`select id, name, is_active, template, updated_at from accounting.posting_rules where company_id = ${h.companyId} order by seq`;
    expect(await sync()).toEqual({ inserted: 0, activated: 0, deactivated: 0 });
    expect(await h.sql`select id, name, is_active, template, updated_at from accounting.posting_rules where company_id = ${h.companyId} order by seq`).toEqual(before);
  });

  it("restores a deleted rule additively but never overwrites a rule the admin modified", async () => {
    const [issued, voided] = (await rulesOf("invoicing")).filter((r) => r.name !== "Nota de prueba emitida");
    // An admin edit marks the rule modified and keeps its own template.
    await h.runStepUp(h.admin, "accounting.posting_rule.update", { id: issued!.id, template: { ...invoiceIssued.template, description: "Plantilla de la empresa" } });
    await h.sql`delete from accounting.posting_rules where id = ${voided!.id}`;
    const out = await sync();
    expect(out.inserted).toBe(1);
    const after = await rulesOf("invoicing");
    expect(after.map((r) => r.name)).toEqual(NAMES);
    expect(after.find((r) => r.id === issued!.id)).toMatchObject({ is_modified: true, template: { description: "Plantilla de la empresa" } });
    expect(after.find((r) => r.name === voided!.name)).toMatchObject({ is_active: true, is_modified: false });
  });

  it("a disabled module's rules turn inactive, not deleted; enabling it again wakes them, a rule the admin disabled stays off", async () => {
    const [first] = await rulesOf("invoicing");
    await h.runStepUp(h.admin, "accounting.posting_rule.disable", { id: first!.id });
    await h.runStepUp(h.admin, "kernel.admin.module.disable", { moduleId: "invoicing" });
    expect(await sync()).toMatchObject({ inserted: 0, deactivated: 2 });
    const off = await rulesOf("invoicing");
    expect(off).toHaveLength(3);
    expect(off.every((r) => !r.is_active)).toBe(true);
    // The accounting module's own rules are untouched.
    expect((await rulesOf("accounting")).every((r) => r.is_active)).toBe(true);

    // Enabling raises kernel.module.enabled; accounting's consumer for it runs the sync.
    await h.runStepUp(h.admin, "kernel.admin.module.enable", { moduleId: "invoicing" });
    const [event] = await h.sql<{ id: string; payload: { moduleId: string }; created_at: Date; chain_id: string }[]>`
      select id, payload, created_at, chain_id from kernel.outbox where company_id = ${h.companyId} and event = 'kernel.module.enabled' order by created_at desc limit 1`;
    expect(event!.payload).toEqual({ moduleId: "invoicing" });
    const consumer = consumers.for("kernel.module.enabled").find((c) => c.moduleId === "accounting");
    expect(consumer).toBeDefined();
    await consumer!.fn(buildConsumerContext(h.sql, { id: event!.id, event: "kernel.module.enabled", createdAt: event!.created_at, companyId: h.companyId, chainId: event!.chain_id }, h.deps.registry), event!.payload);
    const on = await rulesOf("invoicing");
    expect(on.filter((r) => r.is_active).map((r) => r.name)).toEqual(NAMES.filter((n) => n !== first!.name));
    expect(on.find((r) => r.id === first!.id)).toMatchObject({ is_active: false, is_modified: true });
  });
});

// Owner item 14 (Task 50.14): cogs-posted follows costing, inventory-adjustment follows inventory.
describe("rules moved to their owners (migration 0117)", () => {
  const COGS = "Costo de ventas";
  const ADJ = "Ajuste de inventario";
  const rule = (moduleId: string, name: string) => h.sql<{ id: string; module: string; is_active: boolean; is_modified: boolean }[]>`
    select id, module, is_active, is_modified from accounting.posting_rules where company_id = ${h.companyId} and module = ${moduleId} and name = ${name}`;
  const snapshot = () => h.sql`select id, event, name, journal_id, template, priority, is_default, is_active, is_modified from accounting.posting_rules
    where company_id = ${h.companyId} and name in (${COGS}, ${ADJ}) order by name`;
  const migrate = () => h.sql.unsafe(readFileSync(new URL("../../../../../supabase/migrations/0117_accounting_rules_retag_module.sql", import.meta.url), "utf8"));

  it("a new company gets both rules from the owning manifests, and accounting's own list no longer has them", async () => {
    expect(await rule("costing", COGS)).toHaveLength(1);
    expect(await rule("inventory", ADJ)).toHaveLength(1);
    expect(await rule("accounting", COGS)).toHaveLength(0);
    expect(await rule("accounting", ADJ)).toHaveLength(0);
    const total = await h.sql<{ n: number }[]>`select count(*)::int as n from accounting.posting_rules where company_id = ${h.companyId} and name in (${COGS}, ${ADJ})`;
    expect(total[0]!.n).toBe(2);
  });

  it("the migration re-tags rows still held by accounting by (event, name) and changes nothing else; a modified row is untouched; a second run changes nothing", async () => {
    const before = await snapshot();
    await h.sql`update accounting.posting_rules set module = 'accounting' where company_id = ${h.companyId} and name = ${COGS}`;
    await h.sql`update accounting.posting_rules set module = 'accounting', is_modified = true where company_id = ${h.companyId} and name = ${ADJ}`;
    await migrate();
    expect(await rule("costing", COGS)).toHaveLength(1);
    expect(await rule("accounting", ADJ)).toHaveLength(1);
    expect(await rule("inventory", ADJ)).toHaveLength(0);
    const after = await snapshot();
    expect(after.map((r) => ({ ...r, is_modified: undefined }))).toEqual(before.map((r) => ({ ...r, is_modified: undefined })));
    const once = await h.sql`select id, module from accounting.posting_rules where company_id = ${h.companyId} order by seq`;
    await migrate();
    expect(await h.sql`select id, module from accounting.posting_rules where company_id = ${h.companyId} order by seq`).toEqual(once);
    // Put the adjustment back as an unmodified inventory rule for the next test.
    await h.sql`update accounting.posting_rules set module = 'inventory', is_modified = false where company_id = ${h.companyId} and name = ${ADJ}`;
  });

  it("disabling costing deactivates costing's rules (cogs-posted among them) and neither inventory's nor accounting's; enabling it again wakes them", async () => {
    await h.runStepUp(h.admin, "kernel.admin.module.disable", { moduleId: "costing" });
    expect(await sync()).toMatchObject({ inserted: 0, deactivated: COSTING_POSTING_RULES.length });
    expect((await rule("accounting", "Factura de venta emitida")).every((r) => r.is_active)).toBe(true);
    expect((await rule("costing", COGS))[0]).toMatchObject({ is_active: false, is_modified: false });
    expect((await rule("inventory", ADJ))[0]).toMatchObject({ is_active: true });
    await h.runStepUp(h.admin, "kernel.admin.module.enable", { moduleId: "costing" });
    expect(await sync()).toMatchObject({ activated: COSTING_POSTING_RULES.length });
    expect((await rule("costing", COGS))[0]).toMatchObject({ is_active: true });
  });

  it("a rule the admin modified (disabled) keeps its state when its module goes off and on", async () => {
    const [cogs] = await rule("costing", COGS);
    await h.runStepUp(h.admin, "accounting.posting_rule.disable", { id: cogs!.id });
    await h.runStepUp(h.admin, "kernel.admin.module.disable", { moduleId: "costing" });
    await sync();
    await h.runStepUp(h.admin, "kernel.admin.module.enable", { moduleId: "costing" });
    await sync();
    expect((await rule("costing", COGS))[0]).toMatchObject({ is_active: false, is_modified: true });
  });
});

// Owner item 48 (Task 52.5): the `invoice-voided` default is retired as 0115 retired the combined note rule: an invoice is annulled by its
// credit note of annulment (OD-7), invoicing.invoice.voided is never emitted. Never deleted (entries may reference it).
describe("retired default rule invoice-voided (migration 0142)", () => {
  const OLD = invoiceVoided.name;
  const EVENT = invoiceVoided.event;
  const migration = readFileSync(new URL("../../../../../supabase/migrations/0142_accounting_retire_invoice_voided_rule.sql", import.meta.url), "utf8");
  const migrate = async () => {
    await h.sql.begin(async (tx) => {
      await tx.unsafe(migration);
    });
  };
  const oldRows = () => h.sql<{ id: string; is_active: boolean; is_modified: boolean }[]>`
    select id, is_active, is_modified from accounting.posting_rules where company_id = ${h.companyId} and event = ${EVENT} and name = ${OLD} order by seq`;
  const install = async (state: { active?: boolean; modified?: boolean } = {}) => {
    const [model] = await h.sql<{ module: string; journal_id: string }[]>`
      select r.module, j.id as journal_id from accounting.posting_rules r, accounting.journals j
      where r.company_id = ${h.companyId} and r.event = 'invoicing.invoice.issued' and j.company_id = ${h.companyId} and j.code = ${invoiceVoided.journalCode} limit 1`;
    await h.sql`
      insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default, is_active, is_modified)
      values (${h.companyId}, ${EVENT}, ${OLD}, ${model!.module}, ${model!.journal_id}, ${h.sql.json(invoiceVoided.template as never)}, 100, true, ${state.active ?? true}, ${state.modified ?? false})`;
  };
  const clear = () => h.sql`delete from accounting.posting_rules where company_id = ${h.companyId} and event = ${EVENT} and name = ${OLD}`;

  it("a company's sync does not install it: the accounting rules are the other eight", async () => {
    expect(await oldRows()).toEqual([]);
    expect(await sync()).toEqual({ inserted: 0, activated: 0, deactivated: 0 });
    expect(await oldRows()).toEqual([]);
  });

  it("a company holding the unmodified default: the sync retires it (inactive, marked modified, kept); a second sync and the migration change nothing", async () => {
    await install();
    const out = await sync();
    expect(out.deactivated).toBe(1);
    const [row] = await oldRows();
    expect(row).toMatchObject({ is_active: false, is_modified: true });
    const once = await oldRows();
    expect(await sync()).toEqual({ inserted: 0, activated: 0, deactivated: 0 });
    await migrate();
    await migrate();
    expect(await oldRows()).toEqual(once);
    await clear();
  });

  it("the migration file, run twice, retires the unmodified default of every company without the sync", async () => {
    await install();
    await migrate();
    const once = await oldRows();
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ is_active: false, is_modified: true });
    await migrate();
    expect(await oldRows()).toEqual(once);
    await clear();
  });

  it("a copy the admin modified stays active under the sync and the migration; the migration names the company in a notice", async () => {
    await install({ modified: true });
    await migrate();
    await migrate();
    // The notice itself is not capturable through the shared pool; the file must carry it (companies left are named, not silent).
    expect(migration).toContain("raise notice 'invoice-voided rule left active (modified by the admin) for companies: %', kept");
    await sync();
    const [row] = await oldRows();
    expect(row).toMatchObject({ is_active: true, is_modified: true });
    await clear();
  });

  it("a retired copy is never deleted: an entry that references it keeps pointing at it", async () => {
    await install();
    const [rule] = await oldRows();
    // An entry the rule "posted": a draft made here and repointed at it (a retired rule must stay referenceable).
    const [cc] = await h.sql<{ id: string }[]>`
      insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, ${`R${Date.now() % 100000}`}, 'Centro de prueba 52.5', 'leaf') returning id`;
    const made = await h.run<{ id: string }>(h.admin, "accounting.entry.create", {
      date: "2026-10-15", description: "Asiento de prueba 52.5",
      lines: [{ accountCode: "510506", debit: 100, credit: 0, costCenterId: cc!.id }, { accountCode: "111005", debit: 0, credit: 100 }],
    });
    const entry = { id: made.id };
    await h.sql`update accounting.entries set posting_rule_id = ${rule!.id} where id = ${entry.id}`;
    await sync();
    await migrate();
    expect(await oldRows()).toEqual([{ id: rule!.id, is_active: false, is_modified: true }]);
    expect((await h.sql`select posting_rule_id from accounting.entries where id = ${entry.id}`)[0]!.posting_rule_id).toBe(rule!.id);
    await h.sql`update accounting.entries set posting_rule_id = null where id = ${entry.id}`;
    await clear();
  });
});
