import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers, defineModule, defineProcess, emitAndPostStrict, type ModuleDef } from "@erp/kernel";
import { z } from "zod";
import { accountingHarness, type AccountingHarness } from "./helpers";

// Inline strict posting on the real engine (entity types D8, Task 9 ruling): a probe module's process posts the 2A rule `cogs-posted`
// through emitAndPostStrict in its own transaction. A refusal rolls everything back (no entry, no failure, no outbox row); the
// asynchronous consumer that later receives the same event posts nothing twice; the reversal runs inline and is refused in a closed period.

const probe: ModuleDef = defineModule({
  id: "probe",
  version: "0.0.1",
  dependsOn: ["accounting"],
  icon: "box",
  entities: [],
  processes: [
    defineProcess({
      id: "probe.post", module: "probe", kind: "create", recordAccess: "none", feature: "probe.all", description: "Contabiliza un evento de prueba en línea",
      input: z.object({ event: z.string(), payload: z.record(z.string(), z.unknown()), requireRule: z.boolean().optional() }),
      output: z.looseObject({ posted: z.boolean(), eventId: z.string() }),
      handler: (ctx, input) => emitAndPostStrict(ctx, input.event, input.payload, { requireRule: input.requireRule ?? false }),
    }),
  ],
  features: [{ id: "probe.all", label: "feature.probe.all", processes: ["probe.post"], entities: [] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  menuShared: ["probe."],
});

let h: AccountingHarness;
let year: number;
let costCenterId: string;
const movementId = "0192b4c0-0000-7000-8000-00000000f103";
const payload = (cost: number, date: string, withCenter = true) => ({
  date, number: "CV-1", cogsId: movementId, movementId, lines: [{ cost, ...(withCenter ? { costCenterId } : {}) }],
});
const inline = (p: Record<string, unknown>, requireRule?: boolean) =>
  h.run<{ posted: boolean; eventId: string; entryIds: string[]; reason?: string }>(h.admin, "probe.post", { event: "costing.cogs.posted", payload: p, ...(requireRule === undefined ? {} : { requireRule }) });
const count = async (table: string) => Number((await h.sql.unsafe(`select count(*)::int as n from ${table} where company_id = '${h.companyId}'`))[0]!.n);

beforeAll(async () => {
  h = await accountingHarness({ extraModules: [probe] });
  await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ["probe.post"]);
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
  costCenterId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("inline strict posting", () => {
  it("posts the entry in the caller's transaction, keyed by the event, and the async consumer then posts nothing twice", async () => {
    const out = await inline(payload(550, `${year}-03-15`), true);
    expect(out.entryIds).toHaveLength(1);
    const entries = await h.sql<{ id: string; status: string; total_debit: string; source_event_id: string }[]>`
      select id, status, total_debit, source_event_id from accounting.entries where company_id = ${h.companyId}`;
    expect(entries).toEqual([{ id: out.entryIds[0], status: "posted", total_debit: "550.0000", source_event_id: out.eventId }]);

    const [row] = await h.sql<{ id: string; event: string; payload: unknown; created_at: Date; chain_id: string }[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where id = ${out.eventId}`;
    const ctx = buildConsumerContext(h.sql, { id: row!.id, event: row!.event, createdAt: row!.created_at, companyId: h.companyId, chainId: row!.chain_id }, h.deps.registry);
    await consumers.for(row!.event).find((c) => c.moduleId === "accounting")!.fn(ctx, row!.payload);
    await consumers.for(row!.event).find((c) => c.moduleId === "accounting")!.fn(ctx, row!.payload);
    expect(await count("accounting.entries")).toBe(1);
    expect(await count("accounting.posting_failures")).toBe(0);
  });

  it("a closed period refuses the action: no entry, no failure, no outbox row", async () => {
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    const before = { entries: await count("accounting.entries"), outbox: await count("kernel.outbox") };
    await expect(inline(payload(10, `${year}-02-10`))).rejects.toThrow(/closed_period/);
    expect({ entries: await count("accounting.entries"), outbox: await count("kernel.outbox") }).toEqual(before);
    expect(await count("accounting.posting_failures")).toBe(0);
  });

  it("a missing cost center refuses the action the same way", async () => {
    const before = { entries: await count("accounting.entries"), outbox: await count("kernel.outbox") };
    await expect(inline(payload(10, `${year}-03-16`, false))).rejects.toThrow(/missing_cost_center/);
    expect({ entries: await count("accounting.entries"), outbox: await count("kernel.outbox") }).toEqual(before);
    expect(await count("accounting.posting_failures")).toBe(0);
  });

  it("requires a rule when asked, and answers nothing posted for an event no rule is for", async () => {
    await expect(inline(payload(1, `${year}-03-15`), true).then(() => h.run(h.admin, "probe.post", { event: "nobody.listens", payload: { date: `${year}-03-15` }, requireRule: true }))).rejects.toThrow(/no_rule/);
    expect(await h.run(h.admin, "probe.post", { event: "nobody.listens", payload: { date: `${year}-03-15` } })).toMatchObject({ posted: true, entryIds: [] });
  });
});
