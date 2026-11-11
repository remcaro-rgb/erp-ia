import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costingHarness, good, layerOf, warehouse, type CostingHarness, type OutboxRow } from "./helpers";

// A landed cost that arrives after units of the receipt were sold (plan 2B.2 Task 45, item 37, rulings R45-1..R45-10; owner items 137-139
// decided as recommended, pending the accountant): per receipt line, onHand = min(received, layer qty) and the share splits by units; the
// stock part raises the layer (event landed_cost), the sold part goes to cost of sales in the allocation's own entry (Dr cogs on the cost
// center the request names) and is recorded as a cost event of kind landed_cost_cogs that does not move the layer. Nothing in a past period
// is rewritten; the void reverses both parts exactly. Through the real posting engine on the demo chart (613595 needs a cost center).

let h: CostingHarness;
let w: { id: string; locationId: string };
let year: number;
let supplierId: string;
let costCenterId: string;
const date = (month = 3, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const product = async (sku: string) => (await h.run<{ id: string }>(h.admin, "core.product.create", good(sku))).id;
const post = async (kind: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, on = date()) =>
  (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind, date: on, warehouseId: w.id, lines: lines.map((l) => ({ locationId: w.locationId, ...l })), ...extra })).id;
const cost = async (movementId: string) => h.deliver(await h.movementEvent(movementId), "costing");
const receipt = async (lines: { productId: string; qty: number; unitCost: number }[], on = date()) => {
  const id = await post("receipt", lines, {}, on);
  await cost(id);
  return id;
};
/** A sale of `qty` units (an entrega's sale issue) and its cost of sales posted. */
const sell = async (productId: string, qty: number, on = date()) => {
  const id = await post("sale_issue", [{ productId, qty: -qty, sourceLineId: randomUUID() }], { sourceEntity: "sales.delivery", sourceId: randomUUID(), costCenterId }, on);
  await cost(id);
  for (const row of await h.cogsEvents(id)) await h.deliver(row, "accounting");
  return id;
};
type Line = { lineId: string; movementLineId: string; productId: string; amount: number; amountStock: number; amountCogs: number; unitCostAdded: number };
type Allocated = { id: string; number: string | null; status: string; amount: number; lines: Line[] };
const allocate = (input: Record<string, unknown>) =>
  h.run<Allocated>(h.admin, "costing.landed_cost.allocate", { date: date(), offsetRole: "payable", partyId: supplierId, costCenterId, ...input });
const eventOf = async (name: string, landedId: string): Promise<OutboxRow> => {
  const rows = await h.sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where event = ${name} and payload->>'landedCostId' = ${landedId}`;
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const entriesOfSource = (sourceId: string) => h.sql<{ id: string; status: string; date: string; reversal_of_id: string | null; total_debit: string; total_credit: string }[]>`
  select id, status, date::text as date, reversal_of_id, total_debit, total_credit from accounting.entries where company_id = ${h.companyId} and source_record_id = ${sourceId} order by posted_at`;
const linesOf = (entryId: string) => h.sql<{ code: string; debit: string; credit: string; cost_center_id: string | null }[]>`
  select a.code, l.debit, l.credit, l.cost_center_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;
const roleCode = async (role: string) =>
  (await h.sql<{ code: string }[]>`
    select a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = ${h.companyId} and m.role = ${role} and m.dimension is null`)[0]!.code;
const eventsOf = (productId: string) => h.sql<{ kind: string; qty: string; amount: string; value_after: string; cost_source: string }[]>`
  select kind, qty, amount, value_after, cost_source from costing.cost_events where company_id = ${h.companyId} and product_id = ${productId} order by seq`;
const ofKind = async (productId: string, kind: string) => (await eventsOf(productId)).filter((e) => e.kind === kind).map((e) => Number(e.amount));
/** A layer's value is the sum of its events' amounts other than landed_cost_cogs (R45-2: that kind records cost of sales, not stock). */
const stockOfEvents = async (productId: string) =>
  Number((await h.sql<{ s: string }[]>`
    select coalesce(sum(amount), 0) as s from costing.cost_events where company_id = ${h.companyId} and product_id = ${productId} and kind <> 'landed_cost_cogs'`)[0]!.s);
const linesOfDoc = (landedId: string) => h.sql<{ amount: string; amount_stock: string; amount_cogs: string }[]>`
  select amount, amount_stock, amount_cogs from costing.landed_cost_lines where landed_cost_id = ${landedId} order by line_no`;
/** The ledger net (debit − credit) on a role's account for what a landed cost posted. */
const netOn = async (landedId: string, role: string) =>
  Number((await h.sql<{ net: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0) as net from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
    join accounting.accounts a on a.id = l.account_id
    where e.company_id = ${h.companyId} and e.source_record_id = ${landedId} and a.code = ${await roleCode(role)}`)[0]!.net);
const setAccounting = (enabled: boolean) => h.sql`
  insert into kernel.company_modules (company_id, module_id, enabled, enabled_at) values (${h.companyId}, 'accounting', ${enabled}, now())
  on conflict (company_id, module_id) do update set enabled = ${enabled}`;

beforeAll(async () => {
  h = await costingHarness({ accounting: true });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
  costCenterId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  w = await warehouse(h, "LATE");
  supplierId = (await h.run<{ id: string }>(h.admin, "core.party.create", {
    kind: ["supplier"], personType: "1", documentType: "31", documentNumber: "900123457", legalName: "Fletes del Caribe S.A.S.", taxResponsibilities: ["O-13"],
    taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@fletes.com",
  })).id;
  await h.sql`update core.parties set dian_status = 'complete' where id = ${supplierId}`;
  for (const tag of ["RUT", "Cámara de Comercio"]) {
    await h.sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
      values (${h.companyId}, 'core.party', ${supplierId}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024,
        ${`${h.seed.tenantId}/${h.companyId}/core.party/${supplierId}/${randomUUID()}-${tag}.pdf`})`;
  }
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("the worked example (item 37): 10 received at $ 8.000, 5 sold, $ 10.000 of freight", () => {
  let p: string;
  let movement: string;
  let sale: string;
  let saleEntryLines: unknown;
  let landed: Allocated;

  it("$ 5.000 to stock (5 units at $ 9.000), $ 5.000 to cost of sales as a landed_cost_cogs event; the layer still equals its stock events", async () => {
    p = await product("LATE-1");
    movement = await receipt([{ productId: p, qty: 10, unitCost: 8000 }], date(3, 1));
    sale = await sell(p, 5, date(3, 5));
    saleEntryLines = await linesOf((await entriesOfSource(sale))[0]!.id);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 40000, avgCost: 8000 });

    landed = await allocate({ movementId: movement, amount: 10000, basis: "value", reference: "FLETE-TARDE" });
    expect(landed.lines).toEqual([expect.objectContaining({ amount: 10000, amountStock: 5000, amountCogs: 5000 })]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 45000, avgCost: 9000 });
    expect(await ofKind(p, "landed_cost")).toEqual([5000]);
    expect(await ofKind(p, "landed_cost_cogs")).toEqual([5000]);
    const cogsEvent = (await eventsOf(p)).find((e) => e.kind === "landed_cost_cogs")!;
    // qty 0, the layer unchanged by it (value_after is the layer's value after the stock part), its own cost source.
    expect({ qty: Number(cogsEvent.qty), valueAfter: Number(cogsEvent.value_after), source: cogsEvent.cost_source }).toEqual({ qty: 0, valueAfter: 45000, source: "landed_cost_cogs" });
    expect(await stockOfEvents(p)).toBe(45000);
    expect(await linesOfDoc(landed.id)).toEqual([{ amount: "10000.0000", amount_stock: "5000.0000", amount_cogs: "5000.0000" }]);
  });

  it("one balanced entry dated the allocation: Dr inventory 5.000 + Dr cogs 5.000 (cost center) / Cr cuentas por pagar 10.000", async () => {
    const row = await eventOf("costing.landed_cost.allocated", landed.id);
    expect(row.payload).toMatchObject({ costCenterId, lines: [{ amount: 10000, cost: 5000, cogsAdjustment: 5000, costCenterId }] });
    const entries = await entriesOfSource(landed.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "posted", date: date(), total_debit: "10000.0000", total_credit: "10000.0000" });
    expect(await linesOf(entries[0]!.id)).toEqual([
      { code: await roleCode("inventory"), debit: "5000.0000", credit: "0.0000", cost_center_id: null },
      { code: await roleCode("cogs"), debit: "5000.0000", credit: "0.0000", cost_center_id: costCenterId },
      { code: await roleCode("payable"), debit: "0.0000", credit: "10000.0000", cost_center_id: null },
    ]);
  });

  it("no restatement: the sale's cost events and its cost of sales entry are untouched", async () => {
    expect((await eventsOf(p)).filter((e) => e.kind === "sale_issue").map((e) => Number(e.amount))).toEqual([-40000]);
    const saleEntries = await entriesOfSource(sale);
    expect(saleEntries).toHaveLength(1);
    expect(await linesOf(saleEntries[0]!.id)).toEqual(saleEntryLines);
  });

  it("several allocations on one receipt are additive: a second $ 2.000 splits 1.000 / 1.000", async () => {
    const second = await allocate({ movementId: movement, amount: 2000, basis: "value" });
    expect(second.lines.map((l) => [l.amountStock, l.amountCogs])).toEqual([[1000, 1000]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 46000, avgCost: 9200 });
    expect(await ofKind(p, "landed_cost_cogs")).toEqual([5000, 1000]);
    expect(await stockOfEvents(p)).toBe(46000);
  });
});

describe("the split per line", () => {
  it("nothing sold: exactly as before (one landed_cost event, no cogs event, Dr inventory / Cr the role, cogsAdjustment 0)", async () => {
    const p = await product("LATE-2");
    const movement = await receipt([{ productId: p, qty: 4, unitCost: 50 }]);
    const landed = await allocate({ movementId: movement, amount: 20, basis: "value" });
    expect(landed.lines.map((l) => [l.amount, l.amountStock, l.amountCogs])).toEqual([[20, 20, 0]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 4, value: 220, avgCost: 55 });
    expect((await eventsOf(p)).map((e) => e.kind)).toEqual(["receipt", "landed_cost"]);
    const row = await eventOf("costing.landed_cost.allocated", landed.id);
    expect((row.payload.lines as Record<string, unknown>[])[0]).toMatchObject({ amount: 20, cost: 20, cogsAdjustment: 0 });
    const [entry] = await entriesOfSource(landed.id);
    expect((await linesOf(entry!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      [await roleCode("inventory"), "20.0000", "0.0000"],
      [await roleCode("payable"), "0.0000", "20.0000"],
    ]);
  });

  it("all sold (layer qty 0): the whole share to cost of sales, the layer's value unchanged, no landed_cost event", async () => {
    const p = await product("LATE-3");
    const movement = await receipt([{ productId: p, qty: 3, unitCost: 100 }]);
    await sell(p, 3);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 0, value: 0, avgCost: 100 });
    const landed = await allocate({ movementId: movement, amount: 45, basis: "quantity" });
    expect(landed.lines.map((l) => [l.amountStock, l.amountCogs])).toEqual([[0, 45]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 0, value: 0, avgCost: 100 });
    expect(await ofKind(p, "landed_cost")).toEqual([]);
    expect(await ofKind(p, "landed_cost_cogs")).toEqual([45]);
    const [entry] = await entriesOfSource(landed.id);
    expect((await linesOf(entry!.id)).map((l) => [l.code, l.debit, l.credit, l.cost_center_id])).toEqual([
      [await roleCode("cogs"), "45.0000", "0.0000", costCenterId],
      [await roleCode("payable"), "0.0000", "45.0000", null],
    ]);
  });

  it("two lines, one partly sold, odd cents: every line's parts add up to its share and the shares to the amount, to the cent", async () => {
    const a = await product("LATE-4A");
    const b = await product("LATE-4B");
    const movement = await receipt([{ productId: a, qty: 10, unitCost: 100 }, { productId: b, qty: 7, unitCost: 100 }]);
    await sell(a, 3);
    // 100,01 by quantity over 10 and 7: 58,83 and 41,18; line A keeps 7 of 10 on hand: 58,83 × 7/10 = 41,181 → 41,18 to stock, 17,65 to cogs.
    const landed = await allocate({ movementId: movement, amount: 100.01, basis: "quantity" });
    expect(landed.lines.map((l) => [l.amount, l.amountStock, l.amountCogs])).toEqual([[58.83, 41.18, 17.65], [41.18, 41.18, 0]]);
    for (const l of await linesOfDoc(landed.id)) expect(Math.round(Number(l.amount_stock) * 100) + Math.round(Number(l.amount_cogs) * 100)).toBe(Math.round(Number(l.amount) * 100));
    const [entry] = await entriesOfSource(landed.id);
    expect(entry).toMatchObject({ total_debit: "100.0100", total_credit: "100.0100" });
    expect(await layerOf(h, a, w.id)).toEqual({ qty: 7, value: 741.18, avgCost: 105.8829 });
    expect(await stockOfEvents(a)).toBe(741.18);
  });

  it("two lines of the same product share its layer: the units on hand are given to the lines in order, never twice", async () => {
    const p = await product("LATE-5");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 10 }, { productId: p, qty: 5, unitCost: 10 }]);
    await sell(p, 3);
    // 7 on hand: line 1 takes 5 (all of its units), line 2 the 2 left; 10 + 10 by quantity → line 1 10 / 0, line 2 4 / 6.
    const landed = await allocate({ movementId: movement, amount: 20, basis: "quantity" });
    expect(landed.lines.map((l) => [l.amountStock, l.amountCogs])).toEqual([[10, 0], [4, 6]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 7, value: 84, avgCost: 12 });
  });

  it("units sold and no cost center named: the cost of sales account asks for one, refused with nothing written", async () => {
    const p = await product("LATE-6");
    const movement = await receipt([{ productId: p, qty: 2, unitCost: 10 }]);
    await sell(p, 1);
    const before = { layer: await layerOf(h, p, w.id), events: await eventsOf(p), docs: await h.sql`select id from costing.landed_costs where movement_id = ${movement}` };
    await expect(allocate({ movementId: movement, amount: 4, basis: "value", costCenterId: undefined })).rejects.toThrow(/missing_cost_center/);
    expect({ layer: await layerOf(h, p, w.id), events: await eventsOf(p), docs: await h.sql`select id from costing.landed_costs where movement_id = ${movement}` }).toEqual(before);
  });
});

describe("void and periods", () => {
  it("a void after more units moved reverses both parts exactly (events and entry); the layer equals its stock events", async () => {
    const p = await product("LATE-7");
    const movement = await receipt([{ productId: p, qty: 10, unitCost: 100 }]);
    await sell(p, 4);
    const landed = await allocate({ movementId: movement, amount: 300, basis: "value" });
    expect(landed.lines.map((l) => [l.amountStock, l.amountCogs])).toEqual([[180, 120]]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 6, value: 780, avgCost: 130 });
    await sell(p, 5);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 1, value: 130, avgCost: 130 });

    await h.runStepUp(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Flete duplicado", date: date() });
    expect(await ofKind(p, "landed_cost")).toEqual([180, -180]);
    expect(await ofKind(p, "landed_cost_cogs")).toEqual([120, -120]);
    // The 180 comes out of what remains (the sales keep their cost, as a void always did): 1 unit worth -50.
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 1, value: -50, avgCost: 0 });
    expect(await stockOfEvents(p)).toBe(-50);
    const entries = await entriesOfSource(landed.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.reversal_of_id).toBe(entries[0]!.id);
    expect(await netOn(landed.id, "inventory")).toBe(0);
    expect(await netOn(landed.id, "cogs")).toBe(0);
    expect(await netOn(landed.id, "payable")).toBe(0);
  });

  it("an allocation dated in a closed period is refused and writes nothing", async () => {
    const p = await product("LATE-8");
    const movement = await receipt([{ productId: p, qty: 4, unitCost: 10 }], date(1, 10));
    await sell(p, 2, date(1, 20));
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    try {
      const footprint = async () => ({
        layer: await layerOf(h, p, w.id), events: await eventsOf(p),
        docs: Number((await h.sql`select count(*)::int as n from costing.landed_costs where company_id = ${h.companyId}`)[0]!.n),
        entries: Number((await h.sql`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n),
      });
      const before = await footprint();
      await expect(allocate({ movementId: movement, amount: 8, basis: "value", date: date(2, 10) })).rejects.toThrow(/closed_period/);
      expect(await footprint()).toEqual(before);
    } finally {
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
    }
  });

  it("accounting off: the event parks with the split, and when accounting is enabled the consumer posts Dr inventory + Dr cogs / Cr", async () => {
    const p = await product("LATE-9");
    const movement = await receipt([{ productId: p, qty: 2, unitCost: 100 }]);
    await sell(p, 1);
    await setAccounting(false);
    try {
      const landed = await allocate({ movementId: movement, amount: 50, basis: "value" });
      expect(landed.lines.map((l) => [l.amountStock, l.amountCogs])).toEqual([[25, 25]]);
      expect(await entriesOfSource(landed.id)).toEqual([]);
      const row = await eventOf("costing.landed_cost.allocated", landed.id);
      await setAccounting(true);
      await h.deliver(row, "accounting");
      const [entry] = await entriesOfSource(landed.id);
      expect((await linesOf(entry!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
        [await roleCode("inventory"), "25.0000", "0.0000"],
        [await roleCode("cogs"), "25.0000", "0.0000"],
        [await roleCode("payable"), "0.0000", "50.0000"],
      ]);
    } finally {
      await setAccounting(true);
    }
  });
});

describe("migration 0155", () => {
  const migration = readFileSync(new URL("../../../../../supabase/migrations/0155_costing_landed_cogs.sql", import.meta.url), "utf8");
  const payableRule = async () => (await h.sql<{ template: { lines: { role: string }[] }; updated_at: Date }[]>`
    select template, updated_at from accounting.posting_rules where company_id = ${h.companyId} and event = 'costing.landed_cost.allocated'
      and template->'when'->0->>'equals' = 'payable'`)[0]!;
  const seedOld = async (modified: boolean) => {
    const t = (await payableRule()).template;
    const old = { ...t, lines: t.lines.filter((l) => l.role !== "cogs") };
    await h.sql`update accounting.posting_rules set template = ${h.sql.json(old as never)}, is_modified = ${modified}
      where company_id = ${h.companyId} and event = 'costing.landed_cost.allocated' and template->'when'->0->>'equals' = 'payable'`;
  };

  it("adds the cogs line to an unedited copy, leaves an edited one alone, and is a no-op the second time", async () => {
    expect((await payableRule()).template.lines.map((l) => l.role)).toEqual(["inventory", "cogs", "payable"]);
    await seedOld(true);
    await h.sql.unsafe(migration);
    expect((await payableRule()).template.lines.map((l) => l.role)).toEqual(["inventory", "payable"]);
    await seedOld(false);
    await h.sql.unsafe(migration);
    const patched = await payableRule();
    expect(patched.template.lines.map((l) => l.role)).toEqual(["inventory", "cogs", "payable"]);
    await h.sql.unsafe(migration);
    expect((await payableRule()).updated_at).toEqual(patched.updated_at);
  });

  it("gives a parked allocation written before it cogsAdjustment 0 on every line, and leaves a delivered one as it was", async () => {
    const p = await product("LATE-10");
    const movement = await receipt([{ productId: p, qty: 2, unitCost: 100 }]);
    await setAccounting(false);
    try {
      const landed = await allocate({ movementId: movement, amount: 10, basis: "value" });
      const row = await eventOf("costing.landed_cost.allocated", landed.id);
      const old = { ...row.payload, lines: (row.payload.lines as Record<string, unknown>[]).map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== "cogsAdjustment"))) };
      await h.sql`update kernel.outbox set payload = ${h.sql.json(old as never)} where id = ${row.id}`;
      await h.sql.unsafe(migration);
      const after = await eventOf("costing.landed_cost.allocated", landed.id);
      expect((after.payload.lines as Record<string, unknown>[]).map((l) => l.cogsAdjustment)).toEqual([0]);
      await setAccounting(true);
      await h.deliver(after, "accounting");
      expect(await entriesOfSource(landed.id)).toHaveLength(1);
    } finally {
      await setAccounting(true);
    }
  });
});
