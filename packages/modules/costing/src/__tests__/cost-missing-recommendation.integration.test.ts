import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costingHarness, good, warehouse, type CostingHarness, type OutboxRow } from "./helpers";

// A product moved without a known cost is told to whoever can fix it (owner item 36, design §22.28, plan 2B Task 38): besides its own
// costing.cost_missing row (the detail, as built in Task 8), costing raises one kernel recommendation per open cost_missing row, addressed to
// the holders of inventory.adjustment.post (the fix is an adjustment); a second uncosted movement of the same product and bodega merges into
// it; an entry with a cost, or a void that takes the last uncosted movement back, resolves the row and closes the recommendation. Costing
// writes no other module's table: it only calls ctx.recommendations.

let h: CostingHarness;
let w: { id: string; locationId: string };
let n = 0;
const product = async () => (await h.run<{ id: string }>(h.admin, "core.product.create", good(`RECM-${++n}`))).id;
const post = async (kind: "receipt" | "issue", productId: string, qty: number, unitCost?: number) =>
  (await h.run<{ id: string }>(h.admin, "inventory.movement.post", {
    kind, date: "2026-03-12", warehouseId: w.id, lines: [{ productId, locationId: w.locationId, qty: kind === "issue" ? -qty : qty, ...(unitCost === undefined ? {} : { unitCost }) }],
  })).id;
const cost = async (movementId: string) => h.deliver(await h.movementEvent(movementId), "costing");
const voidCost = async (movementId: string) => {
  const [row] = await h.sql<OutboxRow[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.voided' and payload->>'movementId' = ${movementId}`;
  await h.deliver(row!, "costing");
};
const missingOf = (productId: string) => h.sql<{ id: string; status: string; occurrences: number }[]>`
  select id, status, occurrences from costing.cost_missing where company_id = ${h.companyId} and product_id = ${productId} order by seq`;
const recommendationsOf = (missingId: string) =>
  h.sql<{ status: string; occurrences: number; reason: string; module: string; subject_entity: string; audience_process_id: string; process_id: string; closed_reason: string | null; params: Record<string, { value: unknown; entity?: string; field?: string }> }[]>`
    select r.status, r.occurrences, r.reason, r.module, r.subject_entity, r.audience_process_id, r.process_id, r.closed_reason, r.params
    from kernel.recommendations r where r.company_id = ${h.companyId} and r.subject_id = ${missingId} order by r.seq`;

beforeAll(async () => {
  h = await costingHarness();
  w = await warehouse(h, "RECM");
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.recommendations where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
  await h.cleanup();
});

describe("cost_missing raises a kernel recommendation", () => {
  it("the first uncosted movement raises one, the second of the same product and bodega merges, a costed entry closes it", async () => {
    const p = await product();
    await cost(await post("receipt", p, 4));
    const [missing] = await missingOf(p);
    expect(missing).toMatchObject({ status: "open", occurrences: 1 });
    const [raised] = await recommendationsOf(missing!.id);
    expect(raised).toMatchObject({
      status: "new", occurrences: 1, reason: "cost_missing", module: "costing", subject_entity: "costing.cost_missing",
      audience_process_id: "inventory.adjustment.post", process_id: "costing.movement.cost",
    });
    expect(raised!.params).toEqual({
      product: { value: `Café RECM-${n}`, entity: "core.product", field: "description" },
      warehouse: { value: "Bodega RECM", entity: "inventory.warehouse", field: "name" },
      count: { value: 1 },
    });

    await cost(await post("issue", p, 1));
    expect(await missingOf(p)).toEqual([expect.objectContaining({ id: missing!.id, status: "open", occurrences: 2 })]);
    expect((await recommendationsOf(missing!.id)).map((r) => [r.status, r.occurrences, r.params.count!.value])).toEqual([["new", 2, 2]]);

    await cost(await post("receipt", p, 5, 200));
    expect((await missingOf(p)).map((m) => m.status)).toEqual(["resolved"]);
    expect((await recommendationsOf(missing!.id)).map((r) => [r.status, r.closed_reason])).toEqual([["closed", "cause_fixed"]]);
  });

  it("a void that takes the last uncosted movement back resolves the row and closes the recommendation", async () => {
    const p = await product();
    const receipt = await post("receipt", p, 3);
    await cost(receipt);
    const [missing] = await missingOf(p);
    expect((await recommendationsOf(missing!.id)).map((r) => r.status)).toEqual(["new"]);
    await h.run(h.admin, "inventory.movement.void", { id: receipt, reason: "Entrada equivocada" });
    await voidCost(receipt);
    expect((await missingOf(p)).map((m) => m.status)).toEqual(["resolved"]);
    expect((await recommendationsOf(missing!.id)).map((r) => [r.status, r.closed_reason])).toEqual([["closed", "cause_fixed"]]);
  });
});
