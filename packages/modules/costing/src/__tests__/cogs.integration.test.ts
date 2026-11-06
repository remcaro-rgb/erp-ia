import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costingHarness, eventsOf, good, layerOf, warehouse, type CostingHarness, type OutboxRow } from "./helpers";

// costing.cogs.posted through the real posting engine on the demo chart (plan 2B Task 8, design §8.1): the 2A default rule `cogs-posted`
// posts Dr cogs (613595, which needs a cost center) / Cr inventory (143505). A ledger refusal (a closed period, OD-4) is the engine's posting
// failure and never touches the cost layer, which costing wrote in its own run.

let h: CostingHarness;
let w: { id: string; locationId: string };
let year: number;
let costCenterId: string;
let p: string;

const date = (month: number) => `${year}-${String(month).padStart(2, "0")}-15`;
const post = async (kind: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, on = date(3)) =>
  (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind, date: on, warehouseId: w.id, lines: lines.map((l) => ({ locationId: w.locationId, ...l })), ...extra })).id;
const cost = async (movementId: string) => h.deliver(await h.movementEvent(movementId), "costing");
const saleIssue = (qty: number, on: string) =>
  post("sale_issue", [{ productId: p, qty: -qty, sourceLineId: randomUUID() }], { sourceEntity: "sales.delivery", sourceId: randomUUID(), costCenterId }, on);
const entriesOf = (eventId: string) => h.sql<{ id: string; status: string; total_debit: string; total_credit: string; source_entity: string; source_record_id: string; chain_id: string; description: string }[]>`
  select id, status, total_debit, total_credit, source_entity, source_record_id, chain_id, description from accounting.entries where company_id = ${h.companyId} and source_event_id = ${eventId}`;
const linesOf = (entryId: string) => h.sql<{ code: string; debit: string; credit: string; cost_center_id: string | null }[]>`
  select a.code, l.debit, l.credit, l.cost_center_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;

beforeAll(async () => {
  h = await costingHarness({ accounting: true });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
  costCenterId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  w = await warehouse(h, "COGS");
  p = (await h.run<{ id: string }>(h.admin, "core.product.create", good("COGS-1"))).id;
  await cost(await post("receipt", [{ productId: p, qty: 10, unitCost: 100 }]));
  await cost(await post("receipt", [{ productId: p, qty: 10, unitCost: 120 }]));
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("costing.cogs.posted through the posting engine", () => {
  let cogsRow: OutboxRow;

  it("a sale issue of 5 at an average of 110 posts one balanced Costo de ventas entry: Dr 613595 550 with the cost center, Cr 143505 550", async () => {
    const issue = await saleIssue(5, date(3));
    await cost(issue);
    const cogs = await h.cogsEvents(issue);
    expect(cogs).toHaveLength(1);
    cogsRow = cogs[0]!;
    expect(cogsRow.payload).toMatchObject({ cogsId: issue, movementId: issue, costCenterId, lines: [{ productId: p, qty: 5, unitCost: 110, amount: 550, cost: 550, costCenterId }] });
    await h.deliver(cogsRow, "accounting");
    await h.deliver(cogsRow, "accounting");
    expect(await h.sql`select error_code from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${cogsRow.id}`).toEqual([]);
    const entries = await entriesOf(cogsRow.id);
    expect(entries).toHaveLength(1);
    const [number] = await h.sql<{ number: string }[]>`select number from inventory.movements where id = ${issue}`;
    expect(entries[0]).toMatchObject({ status: "posted", total_debit: "550.0000", total_credit: "550.0000", source_entity: "inventory.movement", source_record_id: issue, chain_id: cogsRow.chain_id, description: `Costo de ventas ${number!.number}` });
    expect(entries[0]!.chain_id).toBe((await h.movementEvent(issue)).chain_id);
    expect(await linesOf(entries[0]!.id)).toEqual([
      { code: "613595", debit: "550.0000", credit: "0.0000", cost_center_id: costCenterId },
      { code: "143505", debit: "0.0000", credit: "550.0000", cost_center_id: null },
    ]);
  });

  it("a sale issue in a closed period: the engine records a closed_period posting failure and the cost layer and cost event stay as costing wrote them", async () => {
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    const issue = await saleIssue(3, date(2));
    await cost(issue);
    const layer = await layerOf(h, p, w.id);
    expect(layer).toEqual({ qty: 12, value: 1320, avgCost: 110 });
    const [row] = await h.cogsEvents(issue);
    await h.deliver(row!, "accounting");
    expect(await entriesOf(row!.id)).toEqual([]);
    const failures = await h.sql<{ error_code: string; status: string }[]>`select error_code, status from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${row!.id}`;
    expect(failures).toEqual([{ error_code: "closed_period", status: "pending" }]);
    expect(await layerOf(h, p, w.id)).toEqual(layer);
    expect(await eventsOf(h, issue)).toEqual([{ kind: "sale_issue", qty: -3, unitCost: 110, amount: -330, source: "average", missing: false, cogsPosted: true }]);
    // Redelivering the movement event to costing emits no second COGS event.
    await cost(issue);
    expect(await h.cogsEvents(issue)).toHaveLength(1);
  });

  it("a sale issue without a cost center reaches the engine, which records missing_cost_center (613595 requires one)", async () => {
    const issue = await post("sale_issue", [{ productId: p, qty: -1, sourceLineId: randomUUID() }], { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    await cost(issue);
    const [row] = await h.cogsEvents(issue);
    expect(row!.payload.costCenterId).toBeUndefined();
    await h.deliver(row!, "accounting");
    const failures = await h.sql<{ error_code: string }[]>`select error_code from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${row!.id}`;
    expect(failures).toEqual([{ error_code: "missing_cost_center" }]);
  });

  // Review item 3: the rule's source is the movement (rule 21: the entry links to it). Migration 0076 brings companies seeded earlier in line.
  it("the rule's source is the movement; migration 0076 patches an unmodified old copy, leaves a modified one alone and is a no-op the second time", async () => {
    const migration = readFileSync(new URL("../../../../../supabase/migrations/0076_accounting_cogs_rule_source.sql", import.meta.url), "utf8");
    const rule = async () => (await h.sql<{ template: { source: unknown }; updated_at: Date }[]>`
      select template, updated_at from accounting.posting_rules where company_id = ${h.companyId} and event = 'costing.cogs.posted'`)[0]!;
    expect((await rule()).template.source).toEqual({ entity: "inventory.movement", id: "$.movementId" });
    const old = { ...(await rule()).template, source: { entity: "costing.cogs", id: "$.cogsId" } };
    const seed = (modified: boolean) => h.sql`
      update accounting.posting_rules set template = ${h.sql.json(old as never)}, is_modified = ${modified} where company_id = ${h.companyId} and event = 'costing.cogs.posted'`;
    const apply = async () => (await h.sql.unsafe(migration)).count;
    await seed(true);
    await apply();
    expect((await rule()).template.source).toEqual({ entity: "costing.cogs", id: "$.cogsId" });
    await seed(false);
    expect(await apply()).toBe(1);
    const patched = await rule();
    expect(patched.template.source).toEqual({ entity: "inventory.movement", id: "$.movementId" });
    expect(await apply()).toBe(0);
    expect((await rule()).updated_at).toEqual(patched.updated_at);
  });
});
