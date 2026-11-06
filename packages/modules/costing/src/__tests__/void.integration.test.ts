import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessContext } from "@erp/kernel";
import { companyDate } from "../processes/void";
import { costingHarness, good, layerOf, warehouse, type CostingHarness, type OutboxRow } from "./helpers";

// The cost of every void of an inventory movement (plan 2B Task 14, the voids carried from the reviews of Tasks 6–9): costing consumes
// inventory.movement.voided and writes the opposite of each cost event of the movement (kind `reversal`), so the layer's value stays the
// sum of its events' amounts. The sale issue and sale return voids, with their COGS reversal on the demo chart, are covered end to end by
// packages/modules/sales/src/__tests__/delivery.integration.test.ts.

let h: CostingHarness;
let w: { id: string; locationId: string };
let n = 0;
const sku = () => `VOID-${++n}`;
const product = async (overrides: Record<string, unknown> = {}) => (await h.run<{ id: string }>(h.admin, "core.product.create", good(sku(), overrides))).id;
const post = async (kind: "receipt" | "issue", lines: { productId: string; qty: number; unitCost?: number }[]) =>
  (await h.run<{ id: string }>(h.admin, "inventory.movement.post", {
    kind, date: "2026-03-10", warehouseId: w.id, lines: lines.map((l) => ({ locationId: w.locationId, ...l, qty: kind === "issue" ? -l.qty : l.qty })),
  })).id;
const voidMovement = (id: string) => h.run(h.admin, "inventory.movement.void", { id, reason: "Registro equivocado" });
const voidedEvent = async (movementId: string): Promise<OutboxRow> => {
  const rows = await h.sql<OutboxRow[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.voided' and payload->>'movementId' = ${movementId}`;
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const costed = async (movementId: string) => h.deliver(await h.movementEvent(movementId), "costing");
const voidCost = async (movementId: string) => h.deliver(await voidedEvent(movementId), "costing");
const events = (movementId: string) => h.sql<{ kind: string; qty: number; amount: number; unit_cost: number; cost_source: string }[]>`
  select kind, qty::float8 as qty, amount::float8 as amount, unit_cost::float8 as unit_cost, cost_source from costing.cost_events
  where company_id = ${h.companyId} and movement_id = ${movementId} order by seq`;
const sumOf = async (productId: string) =>
  Number((await h.sql<{ s: string }[]>`select coalesce(sum(amount), 0) as s from costing.cost_events where company_id = ${h.companyId} and product_id = ${productId}`)[0]!.s);
const missingOf = (productId: string) => h.sql<{ status: string; occurrences: number; qty: number }[]>`
  select status, occurrences, qty::float8 as qty from costing.cost_missing where company_id = ${h.companyId} and product_id = ${productId} order by seq`;
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return error as { code: string; message: string; details?: unknown };
  }
  throw new Error("expected a refusal");
};

beforeAll(async () => {
  h = await costingHarness();
  w = await warehouse(h, "VOID");
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("costing of voided movements", () => {
  it("a voided receipt takes out exactly its units and value; the average is read from what remains; a redelivered void changes nothing", async () => {
    const p = await product();
    await costed(await post("receipt", [{ productId: p, qty: 10, unitCost: 100 }]));
    const second = await post("receipt", [{ productId: p, qty: 5, unitCost: 130 }]);
    await costed(second);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 15, value: 1650, avgCost: 110 });
    await voidMovement(second);
    await voidCost(second);
    expect(await events(second)).toEqual([
      { kind: "receipt", qty: 5, amount: 650, unit_cost: 130, cost_source: "line" },
      { kind: "reversal", qty: -5, amount: -650, unit_cost: 130, cost_source: "reversal" },
    ]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1000, avgCost: 100 });
    expect(await sumOf(p)).toBe(1000);
    await voidCost(second);
    expect(await events(second)).toHaveLength(2);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1000, avgCost: 100 });
  });

  it("a voided issue gives its value back at the cost it left with", async () => {
    const p = await product();
    await costed(await post("receipt", [{ productId: p, qty: 10, unitCost: 100 }]));
    await costed(await post("receipt", [{ productId: p, qty: 10, unitCost: 120 }]));
    const issue = await post("issue", [{ productId: p, qty: 4 }]);
    await costed(issue);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 16, value: 1760, avgCost: 110 });
    await voidMovement(issue);
    await voidCost(issue);
    expect((await events(issue)).map((e) => [e.kind, e.qty, e.amount])).toEqual([["issue", -4, -440], ["reversal", 4, 440]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 20, value: 2200, avgCost: 110 });
  });

  it("a movement voided before costing valued it is valued first, then reversed; its late posted event changes nothing", async () => {
    const p = await product();
    const first = await post("receipt", [{ productId: p, qty: 10, unitCost: 100 }]);
    const second = await post("receipt", [{ productId: p, qty: 10, unitCost: 200 }]);
    await voidMovement(second);
    // The void's event arrives first: costing pulls both receipts through the feed, then takes the second back out.
    await voidCost(second);
    expect((await events(first)).map((e) => e.kind)).toEqual(["receipt"]);
    expect((await events(second)).map((e) => [e.kind, e.qty, e.amount])).toEqual([["receipt", 10, 2000], ["reversal", -10, -2000]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1000, avgCost: 100 });
    await costed(second);
    await costed(first);
    expect(await events(second)).toHaveLength(2);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1000, avgCost: 100 });
  });

  it("a voided movement without a cost takes back the cost_missing occurrence it counted; the last one resolves the row", async () => {
    const p = await product();
    const a = await post("receipt", [{ productId: p, qty: 2 }]);
    await costed(a);
    const b = await post("receipt", [{ productId: p, qty: 3 }]);
    await costed(b);
    expect(await missingOf(p)).toEqual([{ status: "open", occurrences: 2, qty: 5 }]);
    await voidMovement(b);
    await voidCost(b);
    expect(await missingOf(p)).toEqual([{ status: "open", occurrences: 1, qty: 2 }]);
    await voidMovement(a);
    await voidCost(a);
    expect((await missingOf(p)).map((m) => m.status)).toEqual(["resolved"]);
    expect(await layerOf(h, p, w.id)).toMatchObject({ qty: 0, value: 0 });
  });

  it("refuses voiding a receipt while a landed cost is allocated to it (landed_costs_active); once the landed cost is voided, the receipt is", async () => {
    const p = await product();
    const receipt = await post("receipt", [{ productId: p, qty: 10, unitCost: 100 }]);
    await costed(receipt);
    const landed = await h.run<{ id: string; number: string | null }>(h.admin, "costing.landed_cost.allocate", {
      date: "2026-03-10", movementId: receipt, basis: "value", amount: 50, description: "Flete", offsetRole: "suspense",
    }).catch((error: unknown) => error as { code: string; message: string });
    if ("code" in landed) throw new Error(`landed cost not allocated: ${landed.code} ${landed.message}`);
    const refused = await refusal(voidMovement(receipt));
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toMatch(/^landed_costs_active/);
    expect(JSON.stringify(refused.details)).toContain(landed.number ?? landed.id);
    await h.runStepUp(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Flete mal cargado" });
    await voidMovement(receipt);
    await voidCost(receipt);
    expect(await layerOf(h, p, w.id)).toMatchObject({ qty: 0, value: 0 });
    expect(await sumOf(p)).toBe(0);
  });

  it("dates the reversal in the company's time zone: a void on an evening in Bogotá, the last day of the month, lands in that month", async () => {
    // 2026-04-01 00:30 UTC is 2026-03-31 19:30 in Bogotá (UTC−5).
    const ctx = { tx: h.sql, companyId: h.companyId } as unknown as ProcessContext;
    expect(await companyDate(ctx, new Date("2026-04-01T00:30:00Z"))).toBe("2026-03-31");
    expect(await companyDate(ctx, new Date("2026-04-01T05:30:00Z"))).toBe("2026-04-01");

    // The void's event carries the day inventory voided it (inventory.movement.voided.voidedOn, the company's day): costing dates the
    // reversal and costing.cogs.voided with it, not with the UTC day costing happens to run on.
    const p = await product();
    await costed(await post("receipt", [{ productId: p, qty: 5, unitCost: 100 }]));
    const issue = await post("issue", [{ productId: p, qty: 1 }]);
    await costed(issue);
    await voidMovement(issue);
    const voided = await voidedEvent(issue);
    expect(voided.payload).toMatchObject({ voidedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    await h.deliver({ ...voided, payload: { ...voided.payload, voidedOn: "2026-03-31" } }, "costing");
    const [reversal] = await h.sql<{ date: string }[]>`
      select date::text as date from costing.cost_events where company_id = ${h.companyId} and movement_id = ${issue} and kind = 'reversal'`;
    expect(reversal!.date).toBe("2026-03-31");
  });
});
