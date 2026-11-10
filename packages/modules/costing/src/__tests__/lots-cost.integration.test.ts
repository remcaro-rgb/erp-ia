import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costingHarness, eventsOf, good, layerOf, warehouse, type CostingHarness } from "./helpers";

// RG-6 (plan 2B.2 Task 28.2, PG §3.4, item 149, OD-5): costing is not touched by lots. Cost stays per product and bodega, so a lot-tracked
// receipt and issue produce the same cost events, the same layer and the same Costo de ventas entry as an untracked twin.

let h: CostingHarness;
let w: { id: string; locationId: string };
let year: number;
let costCenterId: string;

beforeAll(async () => {
  h = await costingHarness({ accounting: true });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
  costCenterId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  w = await warehouse(h, "LOTC");
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("lots do not change costing (RG-6)", () => {
  it("a lot receipt and issue give the same cost events, layer and COGS entry as the untracked twin", async () => {
    const on = `${year}-03-15`;
    const plain = (await h.run<{ id: string }>(h.admin, "core.product.create", good("TWIN-PLAIN"))).id;
    const lotted = (await h.run<{ id: string }>(h.admin, "core.product.create", good("TWIN-LOT"))).id;
    await h.runStepUp(h.admin, "inventory.product_tracking.set", { productId: lotted, tracking: "lot" });
    const post = async (kind: string, line: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind, date: on, warehouseId: w.id, lines: [{ locationId: w.locationId, ...line }], ...extra })).id;
    const run = async (productId: string, lot: Record<string, unknown>) => {
      const r1 = await post("receipt", { productId, qty: 10, unitCost: 100, ...(lot.first ?? {}) });
      const r2 = await post("receipt", { productId, qty: 10, unitCost: 120, ...(lot.second ?? {}) });
      const issue = await post("sale_issue", { productId, qty: -5, sourceLineId: randomUUID(), ...(lot.issue ?? {}) }, { sourceEntity: "sales.delivery", sourceId: randomUUID(), costCenterId });
      for (const m of [r1, r2, issue]) await h.deliver(await h.movementEvent(m), "costing");
      const cogs = await h.cogsEvents(issue);
      for (const row of cogs) await h.deliver(row, "accounting");
      const entries = await h.sql<{ code: string; debit: string; credit: string }[]>`
        select a.code, l.debit, l.credit from accounting.entries e join accounting.entry_lines l on l.entry_id = e.id join accounting.accounts a on a.id = l.account_id
        where e.company_id = ${h.companyId} and e.source_event_id = any(${cogs.map((c) => c.id)}::uuid[]) order by l.line_no`;
      return {
        events: [...(await eventsOf(h, r1)), ...(await eventsOf(h, r2)), ...(await eventsOf(h, issue))],
        layer: await layerOf(h, productId, w.id),
        // The COGS lines without their own ids (product, movement line): amounts, quantities, costs and cost center.
        cogs: cogs.map((c) => (c.payload as { lines: Record<string, unknown>[] }).lines.map((line) => Object.fromEntries(Object.entries(line).filter(([k]) => k !== "productId" && k !== "lineId")))),
        entries,
      };
    };
    const untracked = await run(plain, {});
    const tracked = await run(lotted, {
      first: { lot: { code: "T-1" } },
      second: { lot: { code: "T-2" } },
      issue: { lot: { code: "T-1" } },
    });
    expect(untracked.layer).toEqual({ qty: 15, value: 1650, avgCost: 110 });
    expect(untracked.entries).toHaveLength(2);
    expect(tracked).toEqual(untracked);
  });
});
