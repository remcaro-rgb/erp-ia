import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "@erp/kernel";
import { costingHarness, eventsOf, good, layerOf, warehouse, type CostingHarness, type OutboxRow } from "./helpers";

// The costing setting «Costo de unidades sin costo conocido» (plan 2B.2 Task 44, owner item 36, design §22.28, rulings R44-1..12): per
// company, `zero` (default: an uncosted line is valued at 0, as always) or `last_known` (the unit cost of the product's most recent real
// cost event, the same bodega first, then any bodega of the company; flagged `last_known` + cost_missing). Covers the valuation under both
// modes, the cost_missing row and recommendation under both, inheritance by traslados and returns, the exit guard (R44-6), the boundary
// of a mode change (R44-8), the COGS and the ledger (R44-7), and the process: permission, step-up, audit, trigger guard, RLS, consult.

let h: CostingHarness;
let a: { id: string; locationId: string };
let n = 0;
let year: number;
let costCenterId: string;
const date = () => `${year}-03-15`;

const product = async (overrides: Record<string, unknown> = {}) => (await h.run<{ id: string }>(h.admin, "core.product.create", good(`UNK-${++n}`, overrides))).id;
const post = async (kind: string, lines: Record<string, unknown>[], at: { id: string; locationId: string }, extra: Record<string, unknown> = {}) =>
  (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind, date: date(), warehouseId: at.id, lines: lines.map((l) => ({ locationId: at.locationId, ...l })), ...extra })).id;
const cost = async (movementId: string) => h.deliver(await h.movementEvent(movementId), "costing");
/** Posts and costs one movement. */
const move = async (kind: string, productId: string, qty: number, at: { id: string; locationId: string }, unitCost?: number, extra: Record<string, unknown> = {}) => {
  const id = await post(kind, [{ productId, qty, ...(unitCost === undefined ? {} : { unitCost }) }], at, extra);
  await cost(id);
  return id;
};
const saleIssue = (productId: string, qty: number, at: { id: string; locationId: string }, lineId = randomUUID()) =>
  post("sale_issue", [{ productId, qty: -qty, sourceLineId: lineId }], at, { sourceEntity: "sales.delivery", sourceId: randomUUID(), costCenterId });
const setMode = (mode: string, caller: Caller = h.admin) => h.runStepUp<{ id: string; mode: string; previous: string }>(caller, "costing.unknown_cost.set", { mode });
const modeInDb = async () => (await h.sql<{ unknown_cost_mode: string }[]>`select unknown_cost_mode from costing.settings where company_id = ${h.companyId}`)[0]?.unknown_cost_mode;
const missingOf = (productId: string) => h.sql<{ id: string; status: string; occurrences: number }[]>`
  select id, status, occurrences from costing.cost_missing where company_id = ${h.companyId} and product_id = ${productId} order by seq`;
const recommendationsOf = (missingId: string) => h.sql<{ status: string; closed_reason: string | null }[]>`
  select status, closed_reason from kernel.recommendations where company_id = ${h.companyId} and subject_id = ${missingId} order by seq`;

/** What the ledger posted for a movement: the entry's debit total (0 when inventory posted nothing, as for an adjustment with no cost). */
const ledgerOf = async (movementId: string): Promise<number> => {
  const event = await h.movementEvent(movementId);
  await h.deliver(event, "accounting");
  const failures = await h.sql`select error_code, error_detail from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${event.id}`;
  if (failures.length > 0) throw new Error(`posting failed: ${JSON.stringify(failures)}`);
  const rows = await h.sql<{ total_debit: string }[]>`select total_debit from accounting.entries where company_id = ${h.companyId} and source_event_id = ${event.id}`;
  return rows.reduce((sum, r) => sum + Number(r.total_debit), 0);
};

beforeAll(async () => {
  h = await costingHarness({ accounting: true });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
  costCenterId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  a = await warehouse(h, "UNKA");
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.recommendations where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
  await h.cleanup();
});

describe("(1) the default is zero, as always", () => {
  it("a company without a settings row, and a row set to zero, value an uncosted receipt and an uncosted issue at 0 (source none)", async () => {
    expect(await modeInDb()).toBeUndefined();
    const b = await warehouse(h, "UNKB1");
    const p = await product();
    await move("receipt", p, 5, a, 100);
    // No row: the uncosted receipt into another bodega enters at 0 although the product has a real cost elsewhere.
    const r1 = await move("receipt", p, 4, b);
    expect(await eventsOf(h, r1)).toEqual([{ kind: "receipt", qty: 4, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    expect(await setMode("zero")).toMatchObject({ mode: "zero", previous: "zero" });
    expect(await modeInDb()).toBe("zero");
    const r2 = await move("receipt", p, 2, b);
    expect(await eventsOf(h, r2)).toEqual([{ kind: "receipt", qty: 2, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    const i = await move("issue", p, -6, b);
    expect(await eventsOf(h, i)).toEqual([{ kind: "issue", qty: -6, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    expect(await layerOf(h, p, b.id)).toMatchObject({ qty: 0, value: 0 });
  });
});

describe("(2) last_known: an issue with no cost of its own takes the product's last real cost", () => {
  it("a bodega with backorders and no history borrows the product's last real cost from another bodega; amount = qty × cost", async () => {
    await setMode("last_known");
    const x = await warehouse(h, "UNKX", { allowBackorders: true });
    const p = await product();
    await move("receipt", p, 4, a, 100);
    const issue = await move("issue", p, -3, x);
    expect(await eventsOf(h, issue)).toEqual([{ kind: "issue", qty: -3, unitCost: 100, amount: -300, source: "last_known", missing: true, cogsPosted: false }]);
    expect(await layerOf(h, p, x.id)).toMatchObject({ qty: -3, value: -300 });
    // The estimate is not invented into the layer as an average: the empty layer keeps none.
    expect((await layerOf(h, p, x.id))!.avgCost).toBeNull();
  });
});

describe("(3) last_known: an uncosted receipt does not dilute the average of a later real one", () => {
  it("10 uncosted units then 5 @ 200: zero gives 15 units worth 1.000 (66,67); last_known with a last cost of 100 gives 2.000 (133,33)", async () => {
    // zero (the control, a product with no cost anywhere).
    await setMode("zero");
    const b = await warehouse(h, "UNKB3");
    const z = await product();
    await move("receipt", z, 10, b);
    await move("receipt", z, 5, b, 200);
    expect(await layerOf(h, z, b.id)).toEqual({ qty: 15, value: 1000, avgCost: 66.6667 });
    // last_known: the product has a real cost of 100 in the other bodega.
    await setMode("last_known");
    const p = await product();
    await move("receipt", p, 1, a, 100);
    const first = await move("receipt", p, 10, b);
    expect(await eventsOf(h, first)).toEqual([{ kind: "receipt", qty: 10, unitCost: 100, amount: 1000, source: "last_known", missing: true, cogsPosted: false }]);
    await move("receipt", p, 5, b, 200);
    expect(await layerOf(h, p, b.id)).toEqual({ qty: 15, value: 2000, avgCost: 133.3333 });
  });

  it("a positive adjustment without a line cost stays at 0 (never estimated) and a sale return without an original is estimated; an adjustment with a line cost keeps it", async () => {
    await setMode("last_known");
    const b = await warehouse(h, "UNKB3B");
    const p = await product();
    await move("receipt", p, 1, a, 80);
    const adjust = async (productId: string, qty: number) => {
      const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", { date: date(), warehouseId: b.id, reason: "Sobrante", costCenterId, lines: [{ productId, locationId: b.locationId, qty }] });
      await cost(adjustment.id);
      return adjustment.id;
    };
    const adj = await adjust(p, 2);
    // An adjustment is never estimated: inventory's ledger posts only the line cost (none: 0), so the layer must move by the same 0.
    expect(await eventsOf(h, adj)).toEqual([{ kind: "adjustment", qty: 2, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    expect(await ledgerOf(adj)).toBe(0);
    // Inventory values an adjustment at the bodega's average or the product's standard cost: that line cost wins over the estimate.
    const q = await product({ standardCost: 5000 });
    await move("receipt", q, 1, a, 70);
    const withCost = await adjust(q, 1);
    expect(await eventsOf(h, withCost)).toEqual([{ kind: "adjustment", qty: 1, unitCost: 5000, amount: 5000, source: "line", missing: false, cogsPosted: false }]);
    expect(await ledgerOf(withCost)).toBe(5000);
    const ret = await move("sale_return", p, 1, await warehouse(h, "UNKB3C"));
    expect((await eventsOf(h, ret))[0]).toMatchObject({ kind: "sale_return", unitCost: 80, source: "last_known", missing: true });
  });
});

describe("(4) no last cost at all", () => {
  it("the first ever movement of the product stays at 0, source none, and raises the cost_missing row and its recommendation", async () => {
    await setMode("last_known");
    const p = await product();
    const r = await move("receipt", p, 3, a);
    expect(await eventsOf(h, r)).toEqual([{ kind: "receipt", qty: 3, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    const [row] = await missingOf(p);
    expect(row).toMatchObject({ status: "open", occurrences: 1 });
    expect((await recommendationsOf(row!.id)).map((x) => x.status)).toEqual(["new"]);
  });
});

describe("(5) bodega fallback and precedence", () => {
  it("the product's real cost in another bodega is used; the same bodega's own real cost wins over a newer one elsewhere", async () => {
    await setMode("last_known");
    const b = await warehouse(h, "UNKB5", { allowBackorders: true });
    const c = await warehouse(h, "UNKC5", { allowBackorders: true });
    const p = await product();
    // Only elsewhere: a (100) → used in b.
    await move("receipt", p, 5, a, 100);
    expect((await eventsOf(h, await move("issue", p, -1, b)))[0]).toMatchObject({ unitCost: 100, source: "last_known" });
    // c has its own real cost (60), then a newer real cost elsewhere (a, 150): the issue in c, whose layer has no average (a layer
    // emptied of its history, as a bodega with units at value 0 would be), takes c's own 60.
    await move("receipt", p, 3, c, 60);
    await move("receipt", p, 2, a, 150);
    await h.sql`update costing.cost_layers set qty = 0, value = 0, avg_cost = null where company_id = ${h.companyId} and product_id = ${p} and warehouse_id = ${c.id}`;
    expect((await eventsOf(h, await move("issue", p, -1, c)))[0]).toMatchObject({ unitCost: 60, source: "last_known", missing: true });
  });
});

describe("(6) an estimated event is never a source", () => {
  it("a newer estimate in another bodega is skipped: the next bodega takes the real cost, not the estimate", async () => {
    await setMode("last_known");
    const b = await warehouse(h, "UNKB6", { allowBackorders: true });
    const c = await warehouse(h, "UNKC6", { allowBackorders: true });
    const p = await product();
    await move("receipt", p, 3, b, 60); // real 60 in b (oldest)
    await move("receipt", p, 3, a, 100); // real 100 in a (newer)
    await h.sql`update costing.cost_layers set qty = 0, value = 0, avg_cost = null where company_id = ${h.companyId} and product_id = ${p} and warehouse_id = ${b.id}`;
    const estimate = await move("issue", p, -1, b); // own bodega: 60, an estimate (the newest event of the product)
    expect((await eventsOf(h, estimate))[0]).toMatchObject({ unitCost: 60, source: "last_known" });
    const next = await move("issue", p, -1, c); // c has no history: the newest REAL cost is a's 100, not b's newer estimate of 60
    expect((await eventsOf(h, next))[0]).toMatchObject({ unitCost: 100, source: "last_known" });
  });
});

describe("(7) cost_missing and its recommendation under both modes", () => {
  for (const mode of ["zero", "last_known"] as const) {
    it(`${mode}: an uncosted movement raises one row and one recommendation; an entry with a cost closes both`, async () => {
      await setMode(mode);
      const b = await warehouse(h, `UNKB7${mode === "zero" ? "Z" : "L"}`);
      const p = await product();
      await move("receipt", p, 1, a, 100);
      await move("receipt", p, 4, b);
      const [row] = await missingOf(p);
      expect(row).toMatchObject({ status: "open", occurrences: 1 });
      expect((await recommendationsOf(row!.id)).map((x) => x.status)).toEqual(["new"]);
      await move("receipt", p, 5, b, 200);
      expect((await missingOf(p)).map((x) => x.status)).toEqual(["resolved"]);
      expect((await recommendationsOf(row!.id)).map((x) => [x.status, x.closed_reason])).toEqual([["closed", "cause_fixed"]]);
    });
  }

  it("last_known: a void of the last uncosted (estimated) movement resolves the row and closes the recommendation", async () => {
    await setMode("last_known");
    const b = await warehouse(h, "UNKB7V");
    const p = await product();
    await move("receipt", p, 1, a, 100);
    const receipt = await move("receipt", p, 3, b);
    const [row] = await missingOf(p);
    expect((await recommendationsOf(row!.id)).map((x) => x.status)).toEqual(["new"]);
    await h.run(h.admin, "inventory.movement.void", { id: receipt, reason: "Entrada equivocada" });
    const [voided] = await h.sql<OutboxRow[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.voided' and payload->>'movementId' = ${receipt}`;
    await h.deliver(voided!, "costing");
    expect((await missingOf(p)).map((x) => x.status)).toEqual(["resolved"]);
    expect((await recommendationsOf(row!.id)).map((x) => [x.status, x.closed_reason])).toEqual([["closed", "cause_fixed"]]);
  });
});

describe("(8) R44-6: an exit is estimated only when the layer holds no units", () => {
  it("units held at value 0 leave at 0, flagged, no failure; a layer with no units takes the estimate", async () => {
    await setMode("zero");
    const b = await warehouse(h, "UNKB8");
    const p = await product();
    await move("receipt", p, 1, a, 100);
    await move("receipt", p, 5, b); // 5 units worth 0 in b
    await setMode("last_known");
    const partial = await move("issue", p, -2, b);
    expect(await eventsOf(h, partial)).toEqual([{ kind: "issue", qty: -2, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    // Even the whole remaining quantity leaves at 0: the estimate never takes value that did not enter (it would dilute the next real receipt).
    const rest = await move("issue", p, -3, b);
    expect(await eventsOf(h, rest)).toEqual([{ kind: "issue", qty: -3, unitCost: 0, amount: 0, source: "none", missing: true, cogsPosted: false }]);
    expect(await layerOf(h, p, b.id)).toMatchObject({ qty: 0, value: 0 });
    await move("receipt", p, 10, b, 200);
    expect(await layerOf(h, p, b.id)).toEqual({ qty: 10, value: 2000, avgCost: 200 });
  });
});

describe("(9) traslados and returns inherit an estimated leg", () => {
  it("a transfer_in follows its out leg: an estimated out leg gives an estimated in leg; a real one stays real", async () => {
    await setMode("last_known");
    const b = await warehouse(h, "UNKB9", { allowBackorders: true });
    const dest = await warehouse(h, "UNKD9");
    const p = await product();
    await move("receipt", p, 1, a, 100);
    const t = await h.run<{ id: string }>(h.admin, "inventory.transfer.create", { date: date(), fromWarehouseId: b.id, toWarehouseId: dest.id, lines: [{ productId: p, fromLocationId: b.locationId, qty: 2 }] });
    await h.run(h.admin, "inventory.transfer.ship", { id: t.id });
    const legs = await h.sql<{ id: string; kind: string }[]>`select id, kind from inventory.movements where source_id = ${t.id} order by seq`;
    for (const leg of legs) await cost(leg.id);
    expect((await eventsOf(h, legs[0]!.id))[0]).toMatchObject({ kind: "transfer_out", unitCost: 100, amount: -200, source: "last_known", missing: true });
    expect((await eventsOf(h, legs[1]!.id))[0]).toMatchObject({ kind: "transfer_in", unitCost: 100, amount: 200, source: "last_known", missing: true });

    // A real out leg keeps its in leg real.
    const q = await product();
    await move("receipt", q, 4, b, 50);
    const t2 = await h.run<{ id: string }>(h.admin, "inventory.transfer.create", { date: date(), fromWarehouseId: b.id, toWarehouseId: dest.id, lines: [{ productId: q, fromLocationId: b.locationId, qty: 2 }] });
    await h.run(h.admin, "inventory.transfer.ship", { id: t2.id });
    const legs2 = await h.sql<{ id: string; kind: string }[]>`select id, kind from inventory.movements where source_id = ${t2.id} order by seq`;
    for (const leg of legs2) await cost(leg.id);
    expect((await eventsOf(h, legs2[1]!.id))[0]).toMatchObject({ kind: "transfer_in", unitCost: 50, source: "transfer", missing: false });
  });

  it("a sale_return of an estimated sale issue is estimated; of a real one, real", async () => {
    await setMode("zero");
    const b = await warehouse(h, "UNKB9R", { allowBackorders: true });
    const p = await product();
    await move("receipt", p, 1, a, 100);
    await setMode("last_known");
    const line = randomUUID();
    const issue = await post("sale_issue", [{ productId: p, qty: -2, sourceLineId: line }], b, { sourceEntity: "sales.delivery", sourceId: randomUUID() });
    await cost(issue);
    expect((await eventsOf(h, issue))[0]).toMatchObject({ unitCost: 100, source: "last_known", missing: true });
    const returned = await post("sale_return", [{ productId: p, qty: 1, returnOf: { sourceEntity: "sales.delivery", sourceLineId: line } }], b);
    await cost(returned);
    expect((await eventsOf(h, returned))[0]).toMatchObject({ kind: "sale_return", unitCost: 100, source: "last_known", missing: true });

    const q = await product();
    await move("receipt", q, 3, b, 40);
    const realLine = randomUUID();
    await cost(await post("sale_issue", [{ productId: q, qty: -2, sourceLineId: realLine }], b, { sourceEntity: "sales.delivery", sourceId: randomUUID() }));
    const realReturn = await post("sale_return", [{ productId: q, qty: 1, returnOf: { sourceEntity: "sales.delivery", sourceLineId: realLine } }], b);
    await cost(realReturn);
    expect((await eventsOf(h, realReturn))[0]).toMatchObject({ unitCost: 40, source: "original_issue", missing: false });
  });
});

describe("(10) a change applies from the next movement costed", () => {
  it("a movement already costed keeps its valuation; the next one follows the new mode", async () => {
    await setMode("zero");
    const b = await warehouse(h, "UNKB10");
    const p = await product();
    await move("receipt", p, 1, a, 100);
    const before = await move("receipt", p, 2, b);
    await setMode("last_known");
    const after = await move("receipt", p, 2, b);
    expect((await eventsOf(h, before))[0]).toMatchObject({ unitCost: 0, source: "none" });
    expect((await eventsOf(h, after))[0]).toMatchObject({ unitCost: 100, source: "last_known" });
    // Posted but not yet costed when the mode changes: valued under the mode in force when its cost event is written.
    const waiting = await post("receipt", [{ productId: p, qty: 1 }], await warehouse(h, "UNKB10W"));
    await setMode("zero");
    await cost(waiting);
    expect((await eventsOf(h, waiting))[0]).toMatchObject({ unitCost: 0, source: "none" });
    expect((await eventsOf(h, after))[0]).toMatchObject({ unitCost: 100, source: "last_known" });
  });
});

describe("(11) COGS and the ledger", () => {
  const cogsEntry = async (movementId: string) => {
    const [event] = await h.cogsEvents(movementId);
    if (!event) return { event: undefined, entry: undefined, lines: [] as { code: string; debit: string; credit: string }[] };
    await h.deliver(event, "accounting");
    const [entry] = await h.sql<{ id: string; status: string; total_debit: string; total_credit: string }[]>`
      select id, status, total_debit, total_credit from accounting.entries where company_id = ${h.companyId} and source_event_id = ${event.id}`;
    const lines = await h.sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.debit, l.credit from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entry!.id} order by l.line_no`;
    return { event, entry, lines };
  };

  it("zero: a sale issue of an uncosted product posts no COGS (every line 0)", async () => {
    await setMode("zero");
    const x = await warehouse(h, "UNKX11Z", { allowBackorders: true });
    const p = await product();
    await move("receipt", p, 1, a, 100);
    const issue = await saleIssue(p, 2, x);
    await cost(issue);
    expect(await h.cogsEvents(issue)).toEqual([]);
  });

  it("last_known: the sale issue emits costing.cogs.posted with the estimated cost, and the entry is Dr cogs / Cr inventory for that amount, balanced", async () => {
    await setMode("last_known");
    const x = await warehouse(h, "UNKX11L", { allowBackorders: true });
    const p = await product();
    await move("receipt", p, 1, a, 100);
    const issue = await saleIssue(p, 2, x);
    await cost(issue);
    const { event, entry, lines } = await cogsEntry(issue);
    expect(event!.payload).toMatchObject({ movementId: issue, lines: [{ productId: p, qty: 2, unitCost: 100, amount: 200, cost: 200 }] });
    expect(entry).toMatchObject({ status: "posted", total_debit: "200.0000", total_credit: "200.0000" });
    expect(lines).toEqual([{ code: "613595", debit: "200.0000", credit: "0.0000" }, { code: "143505", debit: "0.0000", credit: "200.0000" }]);
    expect((await eventsOf(h, issue))[0]).toMatchObject({ amount: -200, source: "last_known", cogsPosted: true });
  });
});

describe("(13) item 76: an average made of estimates is an estimate", () => {
  const rowOf = async (productId: string, warehouseId: string) => (await h.sql<{ id: string; status: string; occurrences: number; estimated: boolean }[]>`
    select id, status, occurrences, estimated from costing.cost_missing where company_id = ${h.companyId} and product_id = ${productId} and warehouse_id = ${warehouseId} order by seq desc`)[0]!;
  const adjust = async (productId: string, qty: number, at: { id: string; locationId: string }) => {
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", { date: date(), warehouseId: at.id, reason: "Ajuste", costCenterId, lines: [{ productId, locationId: at.locationId, qty }] });
    await cost(adjustment.id);
    return adjustment.id;
  };
  let b: { id: string; locationId: string };
  let p: string;

  it("(a) a second uncosted receipt into a layer of estimated units is an estimate: flagged, counted, the row and its recommendation stay open", async () => {
    await setMode("last_known");
    b = await warehouse(h, "UNKB13");
    p = await product();
    await move("receipt", p, 1, a, 100);
    await move("receipt", p, 4, b);
    const second = await move("receipt", p, 2, b);
    expect(await eventsOf(h, second)).toEqual([{ kind: "receipt", qty: 2, unitCost: 100, amount: 200, source: "last_known", missing: true, cogsPosted: false }]);
    const row = await rowOf(p, b.id);
    expect(row).toMatchObject({ status: "open", occurrences: 2, estimated: true });
    expect((await recommendationsOf(row.id)).map((x) => x.status)).toEqual(["new"]);
  });

  it("(b) a traslado of estimated units is an estimate on every leg and the destination gets an open estimated row", async () => {
    const dest = await warehouse(h, "UNKD13");
    const t = await h.run<{ id: string }>(h.admin, "inventory.transfer.create", { date: date(), fromWarehouseId: b.id, toWarehouseId: dest.id, lines: [{ productId: p, fromLocationId: b.locationId, qty: 3 }] });
    await h.run(h.admin, "inventory.transfer.ship", { id: t.id });
    await h.run(h.admin, "inventory.transfer.receive", { id: t.id });
    const legs = await h.sql<{ id: string; kind: string }[]>`select id, kind from inventory.movements where source_id = ${t.id} order by seq`;
    for (const leg of legs) await cost(leg.id);
    for (const leg of legs) expect((await eventsOf(h, leg.id))[0], leg.kind).toMatchObject({ unitCost: 100, source: "last_known", missing: true });
    expect(await rowOf(p, dest.id)).toMatchObject({ status: "open", estimated: true });
  });

  it("(c) a sale issue from the estimated layer is flagged and its COGS posts at the estimate", async () => {
    const issue = await saleIssue(p, 2, b);
    await cost(issue);
    expect((await eventsOf(h, issue))[0]).toMatchObject({ unitCost: 100, amount: -200, source: "last_known", missing: true });
    const [cogs] = await h.cogsEvents(issue);
    expect(cogs!.payload).toMatchObject({ lines: [{ qty: 2, unitCost: 100, amount: 200 }] });
    expect((await rowOf(p, b.id)).occurrences).toBe(4);
  });

  it("(d) an estimate never compounds: no event of the estimated layer is a real source for another bodega", async () => {
    expect(await h.sql`select 1 from costing.cost_events where company_id = ${h.companyId} and product_id = ${p} and warehouse_id = ${b.id} and cost_missing = false`).toEqual([]);
    const d = await warehouse(h, "UNKE13");
    expect((await eventsOf(h, await move("receipt", p, 1, d)))[0]).toMatchObject({ unitCost: 100, source: "last_known", missing: true });
  });

  it("(e) a real receipt resolves the row and clears the marker: the next average-valued line is real again", async () => {
    await move("receipt", p, 5, b, 200);
    const row = await rowOf(p, b.id);
    expect(row).toMatchObject({ status: "resolved" });
    expect((await recommendationsOf(row.id)).map((x) => [x.status, x.closed_reason])).toEqual([["closed", "cause_fixed"]]);
    const next = await move("receipt", p, 1, b);
    expect((await eventsOf(h, next))[0]).toMatchObject({ source: "average", missing: false });
  });

  it("(I1, N1) an adjustment in a layer of estimated units keeps the average inventory valued it at: flagged as an estimate, row open, and the ledger equals the layer", async () => {
    const x = await warehouse(h, "UNKB13I");
    const q = await product();
    await move("receipt", q, 1, a, 100);
    await move("receipt", q, 4, x);
    expect(await rowOf(q, x.id)).toMatchObject({ status: "open", estimated: true });
    const plus = await adjust(q, 2, x);
    const minus = await adjust(q, -1, x);
    expect((await eventsOf(h, plus))[0]).toMatchObject({ kind: "adjustment", qty: 2, unitCost: 100, amount: 200, source: "last_known", missing: true });
    expect((await eventsOf(h, minus))[0]).toMatchObject({ kind: "adjustment", qty: -1, unitCost: 100, amount: -100, source: "last_known", missing: true });
    expect(await ledgerOf(plus)).toBe(200);
    expect(await ledgerOf(minus)).toBe(100);
    expect(await rowOf(q, x.id)).toMatchObject({ status: "open", occurrences: 3 });
  });

  it("(N1) adjustments in last_known mode: the layer moves exactly by what the ledger posts, with a cost, without one, and into an empty layer", async () => {
    const x = await warehouse(h, "UNKB13N", { allowBackorders: true });
    const q = await product();
    await move("receipt", q, 1, a, 100);
    const none = await adjust(q, 3, x); // no average, no standard cost: 0 on both sides
    const minusNone = await adjust(q, -3, x); // layer with no cost: 0 on both sides
    for (const id of [none, minusNone]) {
      expect((await eventsOf(h, id))[0]).toMatchObject({ unitCost: 0, amount: 0, source: "none", missing: true });
      expect(await ledgerOf(id)).toBe(0);
    }
    const [sum] = await h.sql<{ value: string }[]>`select value from costing.cost_layers where company_id = ${h.companyId} and product_id = ${q} and warehouse_id = ${x.id}`;
    expect(Number(sum!.value)).toBe(0);
  });

  it("(N2) voiding the real receipt that resolved an estimated row reopens it, and the estimates are not laundered into real costs", async () => {
    const x = await warehouse(h, "UNKB13V");
    const q = await product();
    await move("receipt", q, 1, a, 100);
    await move("receipt", q, 4, x);
    const real = await move("receipt", q, 5, x, 200);
    const [resolved] = await missingOf(q);
    expect(resolved).toMatchObject({ status: "resolved" });
    await h.run(h.admin, "inventory.movement.void", { id: real, reason: "Entrada equivocada" });
    const [voided] = await h.sql<OutboxRow[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.voided' and payload->>'movementId' = ${real}`;
    await h.deliver(voided!, "costing");
    expect(await rowOf(q, x.id)).toMatchObject({ id: resolved!.id, status: "open", estimated: true });
    expect((await recommendationsOf(resolved!.id)).map((r) => r.status)).toEqual(["closed", "new"]);
    const next = await move("receipt", q, 1, x);
    expect((await eventsOf(h, next))[0]).toMatchObject({ source: "last_known", missing: true });
  });

  it("(M1) the cost of a voided receipt is not a last known cost", async () => {
    const q = await product();
    await move("receipt", q, 1, a, 100);
    const wrong = await move("receipt", q, 1, a, 900);
    await h.run(h.admin, "inventory.movement.void", { id: wrong, reason: "Costo mal digitado" });
    const [voided] = await h.sql<OutboxRow[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.voided' and payload->>'movementId' = ${wrong}`;
    await h.deliver(voided!, "costing");
    const y = await warehouse(h, "UNKB13M");
    expect((await eventsOf(h, await move("receipt", q, 1, y)))[0]).toMatchObject({ unitCost: 100, source: "last_known" });
  });
});

describe("(12) the process: permission, step-up, audit, trigger, RLS, consult", () => {
  it("a role without the permission is refused; a call without a fresh code asks for it; a bad mode is invalid", async () => {
    await expect(setMode("last_known", h.clerk)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.run(h.admin, "costing.unknown_cost.set", { mode: "last_known" })).rejects.toMatchObject({ code: "step_up_required" });
    await expect(h.runStepUp(h.admin, "costing.unknown_cost.set", { mode: "sometimes" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.runStepUp(h.admin, "costing.unknown_cost.set", { mode: "zero", method: "average" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("is audited (field unknown_cost_mode, before and after, origin, actor, chain), never touches method, and settings.update never touches the mode", async () => {
    await setMode("zero");
    const result = await setMode("last_known");
    expect(result).toMatchObject({ mode: "last_known", previous: "zero" });
    const audits = await h.sql<{ diff: { unknown_cost_mode?: { old: string; new: string } }; origin: string; actor_user_id: string; chain_id: string; process_id: string }[]>`
      select diff, origin, actor_user_id, chain_id, process_id from kernel.audit_log
      where company_id = ${h.companyId} and entity = 'costing.settings' and action = 'update' and diff ? 'unknown_cost_mode' order by occurred_at desc limit 1`;
    expect(audits[0]!.diff.unknown_cost_mode).toEqual({ old: "zero", new: "last_known" });
    expect(audits[0]).toMatchObject({ origin: "ui", actor_user_id: h.admin.claims.sub, chain_id: expect.any(String), process_id: "costing.unknown_cost.set" });
    await h.runStepUp(h.admin, "costing.settings.update", { method: "average" });
    expect(await modeInDb()).toBe("last_known");
    expect((await h.sql<{ method: string }[]>`select method from costing.settings where company_id = ${h.companyId}`)[0]!.method).toBe("average");
    await expect(h.runStepUp(h.admin, "costing.settings.update", { method: "average", unknownCostMode: "zero" })).rejects.toMatchObject({ code: "invalid_input" });
    await setMode("zero");
    expect((await h.sql<{ method: string }[]>`select method from costing.settings where company_id = ${h.companyId}`)[0]!.method).toBe("average");
  });

  it("upserts the row when the company has none (the default method), previous zero", async () => {
    const other = { claims: h.seed.claimsFor(h.seed.users.both, h.otherCompanyId), origin: "ui" } as Caller;
    expect(await h.sql`select 1 from costing.settings where company_id = ${h.otherCompanyId}`).toEqual([]);
    expect(await setMode("last_known", other)).toMatchObject({ mode: "last_known", previous: "zero" });
    const [row] = await h.sql<{ method: string; unknown_cost_mode: string }[]>`select method, unknown_cost_mode from costing.settings where company_id = ${h.otherCompanyId}`;
    expect(row).toEqual({ method: "average", unknown_cost_mode: "last_known" });
  });

  it("a direct update by an authenticated user outside the process changes nothing, inside another costing process the trigger refuses it; the service passes; the check holds", async () => {
    await setMode("zero");
    const asUser = (processId: string | null) => h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...h.admin.claims })}, true), set_config('role', 'authenticated', true)`;
      if (processId) await tx`select set_config('erp.audit_process_id', ${processId}, true)`;
      return tx`update costing.settings set unknown_cost_mode = 'last_known' where company_id = ${h.companyId} returning id`;
    });
    // Outside any process the restrictive via_process policy already hides the row (nothing updated); inside another costing process the
    // policy passes and the trigger refuses.
    await expect(asUser(null)).resolves.toEqual([]);
    await expect(asUser("costing.settings.update")).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/costing\.unknown_cost\.set/) });
    expect(await modeInDb()).toBe("zero");
    await h.sql`update costing.settings set unknown_cost_mode = 'last_known' where company_id = ${h.companyId}`;
    expect(await modeInDb()).toBe("last_known");
    await h.sql`update costing.settings set unknown_cost_mode = 'zero' where company_id = ${h.companyId}`;
    await expect(h.sql`update costing.settings set unknown_cost_mode = 'sometimes' where company_id = ${h.companyId}`).rejects.toThrow(/settings_unknown_cost_mode_check/);
  });

  it("RLS: another company's session reads and writes none of company A's mode, in the table and in v_settings", async () => {
    await setMode("last_known");
    const asOther = <T>(fn: (tx: typeof h.sql) => Promise<T>) => h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...h.seed.claimsFor(h.seed.users.both, h.otherCompanyId) })}, true), set_config('role', 'authenticated', true)`;
      return fn(tx as unknown as typeof h.sql);
    });
    const seen = await asOther((tx) => tx`select unknown_cost_mode from costing.settings where company_id = ${h.companyId}`);
    expect(seen).toEqual([]);
    const seenView = await asOther((tx) => tx`select unknown_cost_mode from costing.v_settings where company_id = ${h.companyId}`);
    expect(seenView).toEqual([]);
    const updated = await asOther((tx) => tx`update costing.settings set method = 'average' where company_id = ${h.companyId} returning id`);
    expect(updated).toEqual([]);
    expect(await modeInDb()).toBe("last_known");
  });

  it("settings.consult returns unknownCostMode (zero, configured false without a row)", async () => {
    await h.sql`delete from costing.settings where company_id = ${h.otherCompanyId}`;
    const other = { claims: h.seed.claimsFor(h.seed.users.both, h.otherCompanyId), origin: "ui" } as Caller;
    expect(await h.run(other, "costing.settings.consult", {})).toMatchObject({ configured: false, method: "average", unknownCostMode: "zero" });
    await setMode("last_known");
    expect(await h.run(h.admin, "costing.settings.consult", {})).toMatchObject({ configured: true, method: "average", unknownCostMode: "last_known" });
  });
});
