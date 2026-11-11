import { randomUUID } from "node:crypto";
import { withClaims } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { good, warehouseHarness, type Harness } from "./harness";

// Put-away (plan 2B.2 Task 29.3, PG §4.3 step 8; owner item 155; RG-10; migrations 0172 and 0173). The Reglas de ubicación name, per bodega,
// where a category's goods go (or any goods), by priority. warehouse.putaway.suggest lists, per line of a receipt, the ubicación by rule
// (the category's first, then any; a lot stays with the stock of the same lot already shelved); the warehouse consumer of
// inventory.movement.posted raises the «por ubicar» recommendation for a receipt it can suggest for. warehouse.putaway.confirm emits
// warehouse.putaway.confirmed and inventory relocates the stock (inventory.relocation.post, movement kind relocation: two lines per
// relocated line in the same bodega, lot and serial kept). Costing ignores a relocation: no cost event, no entry, the layer unchanged, and
// the costing feed goes on past it. A relocation to another bodega is refused (relocation_cross_warehouse). A receipt posted before the
// module started for the company is not listed (RG-10).

interface SuggestOut {
  movementId: string;
  listed: boolean;
  reason?: string;
  lines: { movementLineId: string; productId: string; lotId: string | null; serialId: string | null; qty: number; fromLocationId: string | null; toLocationId: string | null; basis: string }[];
}

describe("put-away (Task 29.3)", () => {
  let h: Harness;
  let rec: string;
  let shelfA: string;
  let shelfB: string;
  let otherWarehouse: string;
  let otherShelf: string;
  let molido: string;
  let accessory: string;
  let grinder: string;
  let receiptId: string;
  let lotL1: string;

  const onHand = async (productId: string, locationId: string, lotId: string | null = null) =>
    Number((await h.sql<{ q: string }[]>`
      select coalesce(sum(on_hand), 0)::text as q from inventory.stock_levels where company_id = ${h.companyId} and product_id = ${productId}
        and location_id = ${locationId} and (${lotId}::uuid is null or lot_id = ${lotId}::uuid)`)[0]!.q);
  const costingSnapshot = async () => ({
    events: Number((await h.sql<{ n: string }[]>`select count(*)::text as n from costing.cost_events where company_id = ${h.companyId}`)[0]!.n),
    layers: (await h.sql<{ k: string }[]>`select string_agg(product_id::text || ':' || qty::text || ':' || value::text, ',' order by product_id) as k from costing.cost_layers where company_id = ${h.companyId}`)[0]!.k,
    entries: Number((await h.sql<{ n: string }[]>`select count(*)::text as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n),
  });
  const receive = async (lines: unknown[]) => {
    const posted = await h.run<{ id: string }>("inventory.movement.post", { kind: "receipt", date: h.day(2, 10), warehouseId: h.warehouseId, lines });
    expect(await h.drain()).toEqual([]);
    return posted.id;
  };

  beforeAll(async () => {
    h = await warehouseHarness("900373115");
    const loc = async (warehouseId: string, code: string, name: string) => (await h.run<{ id: string }>("inventory.location.create", { warehouseId, code, name })).id;
    rec = await loc(h.warehouseId, "REC", "Recepción");
    shelfA = await loc(h.warehouseId, "EA", "Estante A");
    shelfB = await loc(h.warehouseId, "EB", "Estante B");
    otherWarehouse = (await h.run<{ id: string }>("inventory.warehouse.create", { code: "SEC", name: "Bodega secundaria", allowBackorders: false })).id;
    otherShelf = await loc(otherWarehouse, "S1", "Estante S1");
    const ground = (await h.run<{ id: string }>("core.category.create", { name: `Café molido ${randomUUID().slice(0, 4)}`, ivaRate: "5", otherTaxes: [], defaultUom: "94" })).id;
    const tools = (await h.run<{ id: string }>("core.category.create", { name: `Accesorios ${randomUUID().slice(0, 4)}`, ivaRate: "19", otherTaxes: [], defaultUom: "94" })).id;
    molido = (await h.run<{ id: string }>("core.product.create", good(`MOL-${randomUUID().slice(0, 6)}`, { description: "Café molido 500 g", categoryId: ground }))).id;
    accessory = (await h.run<{ id: string }>("core.product.create", good(`FIL-${randomUUID().slice(0, 6)}`, { description: "Filtro de papel", categoryId: tools, ivaRate: "19" }))).id;
    grinder = (await h.run<{ id: string }>("core.product.create", good(`MOLN-${randomUUID().slice(0, 6)}`, { description: "Molino manual", categoryId: tools, ivaRate: "19" }))).id;
    await h.runStepUp("inventory.product_tracking.set", { productId: molido, tracking: "lot" });
    await h.runStepUp("inventory.product_tracking.set", { productId: grinder, tracking: "serial" });
    // «Café molido → Estante A»; anything else → Estante B.
    await h.run("warehouse.putaway_rule.create", { warehouseId: h.warehouseId, categoryId: ground, locationId: shelfA, priority: 10 });
    await h.run("warehouse.putaway_rule.create", { warehouseId: h.warehouseId, locationId: shelfB, priority: 20 });
  }, 300_000);

  afterAll(async () => {
    await h.cleanup();
  });

  it("(1) migrations 0172 and 0173: the rules have company RLS, audit and seq; a movement may be of kind relocation; a rule names a ubicación of its bodega", async () => {
    const [rule] = await h.sql<{ seq: string; priority: number }[]>`select seq::text, priority from warehouse.putaway_rules where company_id = ${h.companyId} order by priority limit 1`;
    expect(Number(rule!.seq)).toBeGreaterThan(0);
    const [check] = await h.sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'inventory.movements'::regclass and conname = 'movements_kind_check'`;
    expect(check!.def).toContain("relocation");
    expect((await h.refusal(h.run("warehouse.putaway_rule.create", { warehouseId: h.warehouseId, locationId: otherShelf, priority: 30 })))?.message).toMatch(/^invalid_location/);
    const seen = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ id: string }[]>`select id from warehouse.v_putaway_rules`);
    expect(seen).toHaveLength(2);
  });

  it("(2) a receipt into Recepción: «Café molido → Estante A» suggests A, the rest goes to Estante B by the catch-all rule; the receipt is recommended «por ubicar»", async () => {
    receiptId = await receive([
      { productId: molido, locationId: rec, qty: 6, unitCost: 9000, lot: { code: "L1", expiresOn: `${h.year + 1}-10-01` } },
      { productId: accessory, locationId: rec, qty: 4, unitCost: 500 },
      { productId: grinder, locationId: rec, qty: 2, unitCost: 80000, serials: [{ serialNo: `SN-${randomUUID().slice(0, 6)}` }, { serialNo: `SN-${randomUUID().slice(0, 6)}` }] },
    ]);
    lotL1 = (await h.sql<{ id: string }[]>`select id from inventory.lots where product_id = ${molido} and code = 'L1'`)[0]!.id;
    const suggestion = await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: receiptId });
    expect(suggestion.listed).toBe(true);
    const byProduct = (p: string) => suggestion.lines.filter((l) => l.productId === p);
    expect(byProduct(molido).map((l) => [l.qty, l.lotId, l.fromLocationId, l.toLocationId, l.basis])).toEqual([[6, lotL1, rec, shelfA, "rule_category"]]);
    expect(byProduct(accessory).map((l) => [l.qty, l.fromLocationId, l.toLocationId, l.basis])).toEqual([[4, rec, shelfB, "rule_any"]]);
    expect(byProduct(grinder).map((l) => [l.qty, l.toLocationId])).toEqual([[1, shelfB], [1, shelfB]]);
    const [recommended] = await h.sql<{ status: string; reason: string }[]>`
      select status, reason from kernel.recommendations where company_id = ${h.companyId} and subject_entity = 'inventory.movement' and subject_id = ${receiptId}`;
    expect(recommended).toMatchObject({ status: "new", reason: "putaway_pending" });
  });

  it("(3) confirming relocates the stock (all in the shelves, none left in Recepción), lot and serial kept; costing posts nothing and the layer is unchanged", async () => {
    const suggestion = await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: receiptId });
    const before = await costingSnapshot();
    await h.run("warehouse.putaway.confirm", {
      movementId: receiptId,
      lines: suggestion.lines.map((l) => ({ productId: l.productId, ...(l.lotId ? { lotId: l.lotId } : {}), ...(l.serialId ? { serialId: l.serialId } : {}), qty: l.qty, fromLocationId: l.fromLocationId, toLocationId: l.toLocationId })),
    });
    const [confirmed] = await h.outbox("warehouse.putaway.confirmed", "movementId", receiptId);
    expect(confirmed!.payload.lines).toHaveLength(4);
    expect(await h.drain()).toEqual([]);

    const [relocation] = await h.sql<{ id: string; kind: string; number: string; status: string; warehouse_id: string }[]>`
      select id, kind, number, status, warehouse_id from inventory.movements where company_id = ${h.companyId} and kind = 'relocation'`;
    expect(relocation).toMatchObject({ kind: "relocation", status: "saved", warehouse_id: h.warehouseId });
    expect(relocation!.number).toMatch(/^RU-/);
    const lines = await h.sql<{ qty: string; lot_id: string | null; serial_id: string | null; location_id: string }[]>`
      select qty::text, lot_id, serial_id, location_id from inventory.movement_lines where movement_id = ${relocation!.id} order by line_no`;
    expect(lines).toHaveLength(8);
    expect(lines.reduce((s, l) => s + Number(l.qty), 0)).toBe(0);
    expect(await onHand(molido, shelfA, lotL1)).toBe(6);
    expect(await onHand(molido, rec)).toBe(0);
    expect(await onHand(accessory, shelfB)).toBe(4);
    expect(await onHand(accessory, rec)).toBe(0);
    expect(await onHand(grinder, shelfB)).toBe(2);
    expect(await onHand(grinder, rec)).toBe(0);
    const serials = await h.sql<{ serial_status: string }[]>`select serial_status from inventory.serials where product_id = ${grinder}`;
    expect(serials.map((s) => s.serial_status)).toEqual(["available", "available"]);
    // Costing: nothing (no cost event, no entry), the layers as they were.
    expect(await costingSnapshot()).toEqual(before);
    // The recommendation is closed and nothing is left to put away.
    const [recommended] = await h.sql<{ status: string }[]>`select status from kernel.recommendations where company_id = ${h.companyId} and subject_entity = 'inventory.movement' and subject_id = ${receiptId}`;
    expect(recommended!.status).toBe("closed");
    expect((await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: receiptId })).lines).toEqual([]);
    // A redelivered confirmation relocates once.
    await h.redeliver(confirmed!, "inventory");
    expect(await h.sql`select 1 from inventory.movements where company_id = ${h.companyId} and kind = 'relocation'`).toHaveLength(1);
    // The costing feed goes on past the relocation: the next movement is valued.
    const issue = await h.run<{ id: string }>("inventory.movement.post", { kind: "issue", date: h.day(2, 11), warehouseId: h.warehouseId, lines: [{ productId: accessory, locationId: shelfB, qty: -1 }] });
    expect(await h.drain()).toEqual([]);
    expect(await h.sql`select 1 from costing.cost_events where movement_id = ${issue.id}`).toHaveLength(1);
    // A relocation is corrected by another relocation, not voided.
    expect((await h.refusal(h.run("inventory.movement.void", { id: relocation!.id, reason: "x" })))?.message).toMatch(/^movement_kind_not_voidable/);
  });

  it("(4) a lot stays together: more of lot L1 goes where L1 already is, a new lot by the rule", async () => {
    // Lot L1 moved from Estante A to Estante B by hand (the screen's relocation).
    await h.run("inventory.relocation.post", { warehouseId: h.warehouseId, lines: [{ productId: molido, lotId: lotL1, qty: 6, fromLocationId: shelfA, toLocationId: shelfB }] });
    expect(await h.drain()).toEqual([]);
    expect(await onHand(molido, shelfB, lotL1)).toBe(6);
    const second = await receive([
      { productId: molido, locationId: rec, qty: 3, unitCost: 9000, lot: { code: "L1" } },
      { productId: molido, locationId: rec, qty: 5, unitCost: 9000, lot: { code: "L2", expiresOn: `${h.year + 1}-11-01` } },
    ]);
    const suggestion = await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: second });
    expect(suggestion.lines.map((l) => [l.qty, l.toLocationId, l.basis])).toEqual([[3, shelfB, "lot_together"], [5, shelfA, "rule_category"]]);
  });

  it("(5) a relocation to another bodega is refused relocation_cross_warehouse, from the screen and from the put-away", async () => {
    await h.run("inventory.movement.post", { kind: "receipt", date: h.day(2, 12), warehouseId: h.warehouseId, lines: [{ productId: accessory, locationId: rec, qty: 2, unitCost: 500 }] });
    expect(await h.drain()).toEqual([]);
    const direct = await h.refusal(h.run("inventory.relocation.post", { warehouseId: h.warehouseId, lines: [{ productId: accessory, qty: 1, fromLocationId: rec, toLocationId: otherShelf }] }));
    expect(direct).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^relocation_cross_warehouse/) });
    const putaway = await h.refusal(h.run("warehouse.putaway.confirm", { movementId: receiptId, lines: [{ productId: accessory, qty: 1, fromLocationId: shelfB, toLocationId: otherShelf }] }));
    expect(putaway).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^relocation_cross_warehouse/) });
    expect(await onHand(accessory, otherShelf)).toBe(0);
    // More than sits in the ubicación is refused before any event.
    const short = await h.refusal(h.run("warehouse.putaway.confirm", { movementId: receiptId, lines: [{ productId: accessory, qty: 50, fromLocationId: shelfB, toLocationId: shelfA }] }));
    expect(short?.message).toMatch(/^putaway_exceeds_stock/);
  });

  it("(6) RG-10: a receipt posted before the module started for the company is not listed and raises nothing on replay", async () => {
    const old = await receive([{ productId: accessory, locationId: rec, qty: 1, unitCost: 500 }]);
    await h.sql`delete from kernel.recommendations where company_id = ${h.companyId} and subject_id = ${old}`;
    // The company switches the module on after that receipt (company_modules.enabled_at, item 220).
    await h.sql`insert into kernel.company_modules (company_id, module_id, enabled, enabled_at) values (${h.companyId}, 'warehouse', true, now() + interval '1 hour')
      on conflict (company_id, module_id) do update set enabled = true, enabled_at = now() + interval '1 hour'`;
    try {
      expect(await h.run<SuggestOut>("warehouse.putaway.suggest", { movementId: old })).toMatchObject({ listed: false, reason: "before_enabled", lines: [] });
      const [posted] = await h.outbox("inventory.movement.posted", "movementId", old);
      await h.redeliver(posted!, "warehouse", randomUUID());
      expect(await h.sql`select 1 from kernel.recommendations where company_id = ${h.companyId} and subject_id = ${old}`).toHaveLength(0);
    } finally {
      await h.sql`delete from kernel.company_modules where company_id = ${h.companyId} and module_id = 'warehouse'`;
    }
  });
});
