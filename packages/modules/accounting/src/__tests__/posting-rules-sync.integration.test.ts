import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers, defineModule, runProcess, type DefaultPostingRule, type ModuleDef } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "./helpers";
import invoiceIssued from "../rules/defaults/invoice-issued.json" with { type: "json" };
import invoiceVoided from "../rules/defaults/invoice-voided.json" with { type: "json" };
import noteIssued from "../rules/defaults/note-credit-issued.json" with { type: "json" };

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
const NAMES = ["Factura de prueba anulada", "Factura de prueba emitida", "Nota de prueba emitida"];

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness({ extraModules: [invoicing] });
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
    expect((await rulesOf("accounting")).length).toBe(9);
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
