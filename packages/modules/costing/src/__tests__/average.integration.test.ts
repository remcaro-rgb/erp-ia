import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costingHarness, eventsOf, good, layerOf, warehouse, type CostingHarness } from "./helpers";
import type { Caller } from "@erp/kernel";

// The weighted average over real inventory events (plan 2B Task 8): the costing consumer of inventory.movement.posted values every movement
// line in the inventory's own order (the movement seq), raises the products without cost and, for a sale issue, emits costing.cogs.posted.

let h: CostingHarness;
let w: { id: string; locationId: string };
let other: { id: string; locationId: string };
const date = "2026-03-15";

const product = async (sku: string, overrides: Record<string, unknown> = {}) => (await h.run<{ id: string }>(h.admin, "core.product.create", good(sku, overrides))).id;
const post = async (kind: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, at = w) =>
  (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind, date, warehouseId: at.id, lines: lines.map((l) => ({ locationId: at.locationId, ...l })), ...extra })).id;
/** Delivers the movement's event to the costing consumer. */
const cost = async (movementId: string) => h.deliver(await h.movementEvent(movementId), "costing");

beforeAll(async () => {
  h = await costingHarness();
  w = await warehouse(h, "CST1");
  other = await warehouse(h, "CST2");
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("weighted average", () => {
  let p: string;
  let saleIssue: string;
  let saleLineSource: string;

  it("receipts 10 @ 100 and 10 @ 120 give an average of 110; a redelivered event values nothing twice", async () => {
    p = await product("AVG-1");
    const first = await post("receipt", [{ productId: p, qty: 10, unitCost: 100 }]);
    const second = await post("receipt", [{ productId: p, qty: 10, unitCost: 120 }]);
    await cost(first);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1000, avgCost: 100 });
    await cost(second);
    await cost(second);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 20, value: 2200, avgCost: 110 });
    expect(await eventsOf(h, second)).toEqual([{ kind: "receipt", qty: 10, unitCost: 120, amount: 1200, source: "line", missing: false, cogsPosted: false }]);
    const [count] = await h.sql<{ n: number }[]>`select count(*)::int as n from costing.cost_events where company_id = ${h.companyId} and product_id = ${p}`;
    expect(count!.n).toBe(2);
  });

  it("a sale issue of 5 is valued at 110 (COGS 550) and emits costing.cogs.posted once, in the 2A fixture's shape plus the brief's fields", async () => {
    saleLineSource = randomUUID();
    const deliveryId = randomUUID();
    saleIssue = await post("sale_issue", [{ productId: p, qty: -5, sourceLineId: saleLineSource }], { sourceEntity: "sales.delivery", sourceId: deliveryId });
    await cost(saleIssue);
    await cost(saleIssue);
    expect(await eventsOf(h, saleIssue)).toEqual([{ kind: "sale_issue", qty: -5, unitCost: 110, amount: -550, source: "average", missing: false, cogsPosted: true }]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 15, value: 1650, avgCost: 110 });
    const cogs = await h.cogsEvents(saleIssue);
    expect(cogs).toHaveLength(1);
    const movementRow = await h.movementEvent(saleIssue);
    expect(cogs[0]!.chain_id).toBe(movementRow.chain_id);
    const [number] = await h.sql<{ number: string }[]>`select number from inventory.movements where id = ${saleIssue}`;
    expect(cogs[0]!.payload).toEqual({
      cogsId: saleIssue,
      movementId: saleIssue,
      number: number!.number,
      date,
      sourceRef: { entity: "sales.delivery", id: deliveryId },
      lines: [{ lineId: expect.any(String), productId: p, categoryId: null, warehouseId: w.id, qty: 5, unitCost: 110, amount: 550, cost: 550 }],
    });
  });

  it("an issue after another receipt is valued at the new average (10 @ 140: average 122, issue 5 → 610) and emits no COGS", async () => {
    await cost(await post("receipt", [{ productId: p, qty: 10, unitCost: 140 }]));
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 25, value: 3050, avgCost: 122 });
    const issue = await post("issue", [{ productId: p, qty: -5 }]);
    await cost(issue);
    expect(await eventsOf(h, issue)).toEqual([{ kind: "issue", qty: -5, unitCost: 122, amount: -610, source: "average", missing: false, cogsPosted: false }]);
    expect(await h.cogsEvents(issue)).toEqual([]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 20, value: 2440, avgCost: 122 });
  });

  it("a returned unit re-enters at the original issue's cost (110), not at the current average (122)", async () => {
    const ret = await post("sale_return", [{ productId: p, qty: 1, returnOf: { sourceEntity: "sales.delivery", sourceLineId: saleLineSource } }]);
    await cost(ret);
    // Its cost of sales goes back too (Task 14: costing.cogs.returned, Dr inventory / Cr cogs at the original cost), once, on its own event.
    expect(await eventsOf(h, ret)).toEqual([{ kind: "sale_return", qty: 1, unitCost: 110, amount: 110, source: "original_issue", missing: false, cogsPosted: true }]);
    const returnedCogs = await h.sql<{ payload: { movementId: string; lines: { cost: number }[] } }[]>`
      select payload from kernel.outbox where event = 'costing.cogs.returned' and payload->>'movementId' = ${ret}`;
    expect(returnedCogs.map((r) => r.payload.lines.map((l) => l.cost))).toEqual([[110]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 21, value: 2550, avgCost: 121.4286 });
    const [line] = await h.sql<{ return_of_line_id: string }[]>`select return_of_line_id from inventory.movement_lines where movement_id = ${ret}`;
    const [issued] = await h.sql<{ id: string }[]>`select id from inventory.movement_lines where movement_id = ${saleIssue}`;
    expect(line!.return_of_line_id).toBe(issued!.id);
    // A return that names no sale issue re-enters at the current average.
    const plain = await post("sale_return", [{ productId: p, qty: 1 }]);
    await cost(plain);
    expect(await eventsOf(h, plain)).toEqual([{ kind: "sale_return", qty: 1, unitCost: 121.4286, amount: 121.43, source: "average", missing: false, cogsPosted: true }]);
  });

  it("a return naming a line that is not a sale issue of the product is refused by inventory", async () => {
    const otherProduct = await product("AVG-RET");
    await expect(post("sale_return", [{ productId: otherProduct, qty: 1, returnOf: { sourceEntity: "sales.delivery", sourceLineId: saleLineSource } }]))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("invalid_return") });
    await expect(post("sale_return", [{ productId: p, qty: 1, returnOf: { sourceEntity: "sales.delivery", sourceLineId: randomUUID() } }]))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("invalid_return") });
  });

  it("a negative cost is refused: no movement, no cost event", async () => {
    const q = await product("AVG-NEG");
    await expect(post("receipt", [{ productId: q, qty: 1, unitCost: -1 }])).rejects.toMatchObject({ code: "invalid_input" });
    expect(await h.sql`select 1 from inventory.movement_lines where company_id = ${h.companyId} and product_id = ${q}`).toHaveLength(0);
    expect(await h.sql`select 1 from costing.cost_events where company_id = ${h.companyId} and product_id = ${q}`).toHaveLength(0);
    // The database refuses a negative average too, whoever writes. A negative value is a legal layer state since 0075 (an exit at a
    // given cost removes exactly its amount: the subledger reconciles), so only the average is checked.
    await expect(h.sql`insert into costing.cost_layers (company_id, product_id, warehouse_id, currency, qty, value, avg_cost) values (${h.companyId}, ${q}, ${w.id}, 'COP', 1, 5, -5)`).rejects.toThrow();
  });

  it("a traslado carries the source bodega's average into the transit and destination bodegas", async () => {
    const t = await h.run<{ id: string }>(h.admin, "inventory.transfer.create", { date, fromWarehouseId: w.id, toWarehouseId: other.id, lines: [{ productId: p, fromLocationId: w.locationId, qty: 2 }] });
    await h.run(h.admin, "inventory.transfer.ship", { id: t.id });
    await h.run(h.admin, "inventory.transfer.receive", { id: t.id });
    const legs = await h.sql<{ id: string; kind: string }[]>`select id, kind from inventory.movements where source_id = ${t.id} order by seq`;
    expect(legs.map((l) => l.kind)).toEqual(["transfer_out", "transfer_in", "transfer_out", "transfer_in"]);
    // Delivered last-first: costing values them in their own order anyway.
    for (const leg of [...legs].reverse()) await cost(leg.id);
    const avg = 121.4286;
    expect((await eventsOf(h, legs[0]!.id))[0]).toMatchObject({ unitCost: avg, amount: -242.86, source: "average" });
    expect((await eventsOf(h, legs[1]!.id))[0]).toMatchObject({ unitCost: avg, amount: 242.86, source: "transfer" });
    // The transit layer holds (2, 242.86): its average, read as value / qty, is 121.43, and the leg out of it carries exactly 242.86.
    expect((await eventsOf(h, legs[3]!.id))[0]).toMatchObject({ unitCost: 121.43, amount: 242.86, source: "transfer" });
    expect(await layerOf(h, p, other.id)).toEqual({ qty: 2, value: 242.86, avgCost: 121.43 });
    expect((await layerOf(h, p, w.id))!.qty).toBe(20);
  });

  it("an adjustment is valued by inventory at the costing average of its bodega (not the standard cost) and costing takes it at that value", async () => {
    const q = await product("AVG-ADJ", { standardCost: 5000 });
    await cost(await post("receipt", [{ productId: q, qty: 10, unitCost: 100 }]));
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", { date, warehouseId: w.id, reason: "Merma", lines: [{ productId: q, locationId: w.locationId, qty: -2 }] });
    const event = await h.movementEvent(adjustment.id);
    expect((event.payload.lines as { unitCost: number; value: number }[])[0]).toMatchObject({ unitCost: 100, value: -200 });
    await cost(adjustment.id);
    expect(await eventsOf(h, adjustment.id)).toEqual([{ kind: "adjustment", qty: -2, unitCost: 100, amount: -200, source: "line", missing: false, cogsPosted: false }]);
    expect(await layerOf(h, q, w.id)).toEqual({ qty: 8, value: 800, avgCost: 100 });
  });
});

describe("products without cost", () => {
  it("an uncosted entry and a sale issue are valued at 0, raise one open cost_missing row (occurrences 2), emit no COGS and leave invoice_ready alone", async () => {
    const q = await product("MISS-1");
    const readiness = async () => (await h.sql<{ invoice_ready: boolean }[]>`select invoice_ready from core.products where id = ${q}`)[0]!.invoice_ready;
    const ready = await readiness();
    const receipt = await post("receipt", [{ productId: q, qty: 10 }]);
    await cost(receipt);
    expect(await eventsOf(h, receipt)).toEqual([{ kind: "receipt", qty: 10, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    const issue = await post("sale_issue", [{ productId: q, qty: -3, sourceLineId: randomUUID() }], { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    await cost(issue);
    expect(await eventsOf(h, issue)).toEqual([{ kind: "sale_issue", qty: -3, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    expect(await h.cogsEvents(issue)).toEqual([]);
    const missing = await h.sql<{ status: string; occurrences: number; qty: string; first_movement_id: string; last_movement_id: string }[]>`
      select status, occurrences, qty, first_movement_id, last_movement_id from costing.cost_missing where company_id = ${h.companyId} and product_id = ${q}`;
    expect(missing).toEqual([{ status: "open", occurrences: 2, qty: "13.0000", first_movement_id: receipt, last_movement_id: issue }]);
    expect(await readiness()).toBe(ready);
    // The consult process reads it through the masked view.
    const [row] = await h.sql<{ id: string }[]>`select id from costing.cost_missing where company_id = ${h.companyId} and product_id = ${q}`;
    expect(await h.run(h.admin, "costing.cost_missing.consult", { id: row!.id })).toMatchObject({ status: "open", occurrences: 2 });

    // An entry with a cost resolves it.
    const costed = await post("receipt", [{ productId: q, qty: 5, unitCost: 200 }]);
    await cost(costed);
    const [resolved] = await h.sql<{ status: string; resolved_movement_id: string }[]>`select status, resolved_movement_id from costing.cost_missing where company_id = ${h.companyId} and product_id = ${q}`;
    expect(resolved).toEqual({ status: "resolved", resolved_movement_id: costed });
    expect(await layerOf(h, q, w.id)).toEqual({ qty: 12, value: 1000, avgCost: 83.3333 });
  });

  it("the first entry of a product with a standard cost and no line cost takes the standard cost", async () => {
    const q = await product("MISS-STD", { standardCost: 7000 });
    const receipt = await post("receipt", [{ productId: q, qty: 2 }]);
    await cost(receipt);
    expect(await eventsOf(h, receipt)).toEqual([{ kind: "receipt", qty: 2, unitCost: 7000, amount: 14000, source: "standard", missing: false, cogsPosted: false }]);
  });

  it("an adjustment event with costMissing raises cost_missing too and seeds the layer at 0", async () => {
    const q = await product("MISS-ADJ");
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", { date, warehouseId: w.id, reason: "Sobrante", lines: [{ productId: q, locationId: w.locationId, qty: 4 }] });
    const event = await h.movementEvent(adjustment.id);
    expect(event.payload.costMissing).toBe(true);
    await cost(adjustment.id);
    expect(await eventsOf(h, adjustment.id)).toEqual([{ kind: "adjustment", qty: 4, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    expect(await layerOf(h, q, w.id)).toEqual({ qty: 4, value: 0, avgCost: 0 });
    expect(await h.sql`select 1 from costing.cost_missing where company_id = ${h.companyId} and product_id = ${q} and status = 'open'`).toHaveLength(1);
  });
});

describe("order of delivery", () => {
  it("an issue delivered before its receipt is valued after it (inventory's seq order): the receipt is pulled first and the issue costs 100", async () => {
    const q = await product("ORD-1");
    const receipt = await post("receipt", [{ productId: q, qty: 10, unitCost: 100 }]);
    const issue = await post("sale_issue", [{ productId: q, qty: -4, sourceLineId: randomUUID() }], { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    await cost(issue);
    expect(await eventsOf(h, receipt)).toEqual([{ kind: "receipt", qty: 10, unitCost: 100, amount: 1000, source: "line", missing: false, cogsPosted: false }]);
    expect(await eventsOf(h, issue)).toEqual([{ kind: "sale_issue", qty: -4, unitCost: 100, amount: -400, source: "average", missing: false, cogsPosted: true }]);
    // The receipt's own event, arriving late, changes nothing.
    await cost(receipt);
    expect(await layerOf(h, q, w.id)).toEqual({ qty: 6, value: 600, avgCost: 100 });
    expect(await h.sql`select 1 from costing.cost_events where company_id = ${h.companyId} and product_id = ${q}`).toHaveLength(2);
    expect(await h.cogsEvents(issue)).toHaveLength(1);
  });

  it("a sale issue valued during a later movement's delivery emits its COGS only with its own event, on its own chain", async () => {
    const q = await product("ORD-2");
    await cost(await post("receipt", [{ productId: q, qty: 5, unitCost: 300 }]));
    const issue = await post("sale_issue", [{ productId: q, qty: -2, sourceLineId: randomUUID() }], { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    const later = await post("receipt", [{ productId: q, qty: 5, unitCost: 500 }]);
    await cost(later);
    // Valued in order (at 300, before the later receipt), but its COGS waits for its own event.
    expect(await eventsOf(h, issue)).toEqual([{ kind: "sale_issue", qty: -2, unitCost: 300, amount: -600, source: "average", missing: false, cogsPosted: false }]);
    expect(await h.cogsEvents(issue)).toEqual([]);
    await cost(issue);
    const cogs = await h.cogsEvents(issue);
    expect(cogs).toHaveLength(1);
    expect(cogs[0]!.chain_id).toBe((await h.movementEvent(issue)).chain_id);
    expect((cogs[0]!.payload.lines as { amount: number }[])[0]!.amount).toBe(600);
    expect(await layerOf(h, q, w.id)).toEqual({ qty: 8, value: 3400, avgCost: 425 });
  });

  it("the feed is per company: the other company's movements neither wait for nor move this company's position", async () => {
    const otherAdmin = { claims: h.seed.claimsFor(h.seed.users.both, h.otherCompanyId), origin: "ui" as const };
    const ow = await h.run<{ id: string }>(otherAdmin, "inventory.warehouse.create", { code: "OTH", name: "Otra" });
    const op = (await h.run<{ id: string }>(otherAdmin, "core.product.create", good("OTH-1"))).id;
    const m = await h.run<{ id: string }>(otherAdmin, "inventory.movement.post", { kind: "receipt", date, warehouseId: ow.id, lines: [{ productId: op, qty: 3, unitCost: 10 }] });
    const before = await h.sql<{ next_seq: string }[]>`select next_seq from costing.feeds where company_id = ${h.companyId}`;
    await cost(m.id);
    expect(await h.sql<{ next_seq: string }[]>`select next_seq from costing.feeds where company_id = ${h.companyId}`).toEqual(before);
    const [layer] = await h.sql<{ company_id: string; avg_cost: string }[]>`select company_id, avg_cost from costing.cost_layers where product_id = ${op}`;
    expect(layer).toEqual({ company_id: h.otherCompanyId, avg_cost: "10.0000" });
  });

  it("the costing process and the feed function refuse what they must: no consult of another company's layer, no feed outside a costing run", async () => {
    const [layer] = await h.sql<{ id: string }[]>`select id from costing.cost_layers where company_id = ${h.otherCompanyId} limit 1`;
    await expect(h.run(h.admin, "costing.cost_layer.consult", { id: layer!.id })).rejects.toMatchObject({ code: "not_found" });
    const [m] = await h.sql<{ id: string }[]>`select id from inventory.movements where company_id = ${h.companyId} limit 1`;
    await expect(h.sql`select * from inventory.movement_feed(0, ${m!.id})`).rejects.toThrow(/only inside a costing process/);
    await expect(h.sql`select * from costing.average_costs(${w.id}, array[${m!.id}]::uuid[])`).rejects.toThrow(/only inside an inventory or costing process/);
  });
});

describe("event only (review item 1)", () => {
  it("costing.movement.cost is refused from the UI and from the assistant: only the movement's event runs it", async () => {
    const q = await product("ORIG-1");
    const receipt = await post("receipt", [{ productId: q, qty: 1, unitCost: 10 }]);
    for (const origin of ["ui", "agent"] as const) {
      const caller: Caller = { ...h.admin, origin };
      await expect(h.run(caller, "costing.movement.cost", { movementId: receipt })).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await h.sql`select 1 from costing.cost_events where company_id = ${h.companyId} and product_id = ${q}`).toHaveLength(0);
  });
});

describe("the subledger reconciles (review item 2)", () => {
  it("across receipts, issues, a backorder, an entry into the backorder, a return, adjustments and a sale issue: Σ event amounts = layer value, line by line", async () => {
    const back = await warehouse(h, "CSTB", { allowBackorders: true });
    const q = await product("REC-1");
    const at = (kind: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => post(kind, lines, extra, back);
    const saleLine = randomUUID();
    const ids: string[] = [];
    ids.push(await at("receipt", [{ productId: q, qty: 10, unitCost: 100 }]));
    ids.push(await at("sale_issue", [{ productId: q, qty: -4, sourceLineId: saleLine }], { sourceEntity: "sales.delivery", sourceId: randomUUID() }));
    ids.push(await at("issue", [{ productId: q, qty: -9 }])); // below zero: (−3, −300)
    ids.push(await at("receipt", [{ productId: q, qty: 10, unitCost: 120 }])); // (7, 900), average 128.57
    ids.push(await at("sale_return", [{ productId: q, qty: 1, returnOf: { sourceEntity: "sales.delivery", sourceLineId: saleLine } }]));
    ids.push((await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", { date, warehouseId: back.id, reason: "Merma", lines: [{ productId: q, locationId: back.locationId, qty: -1, unitCost: 77 }] })).id);
    ids.push(await at("receipt", [{ productId: q, qty: 3, unitCost: 33.33 }]));
    ids.push(await at("issue", [{ productId: q, qty: -1 }]));
    // An adjustment valued far above the layer: it removes exactly its value (the layer may go below zero value; nothing is floored).
    ids.push((await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", { date, warehouseId: back.id, reason: "Ajuste", lines: [{ productId: q, locationId: back.locationId, qty: -1, unitCost: 5000 }] })).id);
    for (const id of ids) await cost(id);

    const rows = await h.sql<{ amount: string; value_after: string; qty: string; qty_after: string }[]>`
      select amount, value_after, qty, qty_after from costing.cost_events where company_id = ${h.companyId} and product_id = ${q} order by movement_seq`;
    expect(rows).toHaveLength(ids.length);
    let value = 0;
    let qty = 0;
    for (const r of rows) {
      value = Math.round((value + Number(r.amount)) * 100) / 100;
      qty = Math.round((qty + Number(r.qty)) * 1e4) / 1e4;
      expect(Number(r.value_after)).toBe(value);
      expect(Number(r.qty_after)).toBe(qty);
    }
    const layer = (await layerOf(h, q, back.id))!;
    expect(layer.value).toBe(value);
    expect(layer.qty).toBe(qty);
    // The entry into the backorder keeps the −300: (7, 900).
    expect(Number(rows[3]!.value_after)).toBe(900);
    expect(layer.value).toBeLessThan(0);
  });
});

describe("concurrency (review item 4)", () => {
  it("two deliveries at once (a receipt and a sale issue of one company) leave the right layer and exactly one COGS", async () => {
    const q = await product("CONC-1");
    const receipt = await post("receipt", [{ productId: q, qty: 10, unitCost: 100 }]);
    const issue = await post("sale_issue", [{ productId: q, qty: -3, sourceLineId: randomUUID() }], { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    const [r, i] = [await h.movementEvent(receipt), await h.movementEvent(issue)];
    await Promise.all([h.deliver(i, "costing"), h.deliver(r, "costing"), h.deliver(i, "costing")]);
    expect(await layerOf(h, q, w.id)).toEqual({ qty: 7, value: 700, avgCost: 100 });
    expect(await eventsOf(h, issue)).toEqual([{ kind: "sale_issue", qty: -3, unitCost: 100, amount: -300, source: "average", missing: false, cogsPosted: true }]);
    expect(await h.cogsEvents(issue)).toHaveLength(1);
  });
});

describe("costing.average_costs follows the module switch (review item 4)", () => {
  it("a company with costing disabled gets no average: its adjustment is valued at the standard cost", async () => {
    const otherAdmin: Caller = { claims: h.seed.claimsFor(h.seed.users.both, h.otherCompanyId), origin: "ui" };
    const ow = await h.run<{ id: string }>(otherAdmin, "inventory.warehouse.create", { code: "OTA", name: "Otra A" });
    const op = (await h.run<{ id: string }>(otherAdmin, "core.product.create", good("OTA-1", { standardCost: 50 }))).id;
    const m = await h.run<{ id: string }>(otherAdmin, "inventory.movement.post", { kind: "receipt", date, warehouseId: ow.id, lines: [{ productId: op, qty: 10, unitCost: 10 }] });
    await cost(m.id);
    const adjust = async () => {
      const a = await h.runStepUp<{ id: string }>(otherAdmin, "inventory.adjustment.post", { date, warehouseId: ow.id, reason: "Merma", lines: [{ productId: op, qty: -1 }] });
      return ((await h.movementEvent(a.id)).payload.lines as { unitCost: number }[])[0]!.unitCost;
    };
    expect(await adjust()).toBe(10);
    await h.sql`insert into kernel.company_modules (company_id, module_id, enabled) values (${h.otherCompanyId}, 'costing', false)
                on conflict (company_id, module_id) do update set enabled = false`;
    try {
      expect(await adjust()).toBe(50);
    } finally {
      await h.sql`delete from kernel.company_modules where company_id = ${h.otherCompanyId} and module_id = 'costing'`;
    }
  });
});

describe("sale returns (review item 5)", () => {
  it("refuses returning a voided sale issue, returning more than was issued (across returns and lines), and names the input line", async () => {
    const q = await product("RET-1");
    await cost(await post("receipt", [{ productId: q, qty: 10, unitCost: 100 }]));
    const voidedLine = randomUUID();
    const voided = await post("sale_issue", [{ productId: q, qty: -2, sourceLineId: voidedLine }], { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    await h.run({ ...h.admin, origin: "event" }, "inventory.movement.void", { id: voided, reason: "Entrega anulada" });
    await expect(post("sale_return", [{ productId: q, qty: 1, returnOf: { sourceEntity: "sales.delivery", sourceLineId: voidedLine } }]))
      .rejects.toMatchObject({ message: expect.stringMatching(/^invalid_return: .*anulada/) });

    const line = randomUUID();
    await post("sale_issue", [{ productId: q, qty: -2, sourceLineId: line }], { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    const returnOf = { sourceEntity: "sales.delivery", sourceLineId: line };
    await post("sale_return", [{ productId: q, qty: 1, returnOf }]);
    await expect(post("sale_return", [{ productId: q, qty: 2, returnOf }])).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_return: Línea 1: .*1/) });
    await expect(post("sale_return", [{ productId: q, qty: 1, returnOf }, { productId: q, qty: 1, returnOf }])).rejects.toMatchObject({ message: expect.stringContaining("invalid_return") });
    // The index is the request's line: line 2 is the bad one.
    const otherProduct = await product("RET-2");
    await expect(post("sale_return", [{ productId: otherProduct, qty: 1 }, { productId: otherProduct, qty: 1, returnOf }]))
      .rejects.toMatchObject({ message: expect.stringMatching(/^invalid_return: Línea 2:/) });
    // The last unit still returns.
    await post("sale_return", [{ productId: q, qty: 1, returnOf }]);
  });
});
