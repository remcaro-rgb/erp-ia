import { randomUUID } from "node:crypto";
import { registerCatalogue } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { translate } from "../../../../i18n/src/index";
import { confirmedOrder, good, warehouseHarness, type Harness } from "./harness";

// «Pendientes por alistar» (plan 2B.2 Task 29.4, PG §4.4): the confirmed pedidos with goods still to deliver and no confirmed alistamiento,
// oldest confirmation first, with what is left to pick and the open alistamiento when there is one. A pedido not confirmed, cancelled,
// delivered or already picked is not listed; services are not picked. Read as the caller through the published views (rule 3, 14).

interface Report { rows: Record<string, unknown>[]; total: number }

describe("Pendientes por alistar (Task 29.4)", () => {
  let h: Harness;
  let product: string;
  let service: string;
  let open: { id: string };
  let picked: { id: string };
  let manual: { id: string };
  let cancelled: { id: string };
  let draft: string;
  let serviceOnly: { id: string };
  const report = (params: Record<string, unknown> = {}) => h.run<Report>("warehouse.report.pending_picks", { params, state: { filters: [], sort: [], page: 1, pageSize: 50 } });
  const numberOf = async (orderId: string) => (await h.sql<{ number: string }[]>`select number from sales.orders where id = ${orderId}`)[0]!.number;

  beforeAll(async () => {
    // The stage reads in the caller's language (the catalogue the app registers).
    registerCatalogue(translate);
    h = await warehouseHarness("860517302");
    const locationId = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "A1", name: "Estante A1" })).id;
    product = (await h.run<{ id: string }>("core.product.create", good(`PEN-${randomUUID().slice(0, 8)}`))).id;
    service = (await h.run<{ id: string }>("core.product.create", good(`SRV-${randomUUID().slice(0, 8)}`, { kind: "service", trackStock: false, uomCode: "94" }))).id;
    await h.run("inventory.movement.post", { kind: "receipt", date: h.day(1, 10), warehouseId: h.warehouseId, lines: [{ productId: product, locationId, qty: 100, unitCost: 100 }] });
    expect(await h.drain()).toEqual([]);
    // Open alistamiento (auto_pick_on_confirm): listed with it.
    open = await confirmedOrder(h, [{ productId: product, qty: 4 }, { productId: service, qty: 1 }]);
    // Picked and confirmed: not listed.
    picked = await confirmedOrder(h, [{ productId: product, qty: 2 }]);
    const [pick] = await h.sql<{ id: string }[]>`select id from warehouse.picks where order_id = ${picked.id}`;
    await h.run("warehouse.pick.confirm", { id: pick!.id });
    expect(await h.drain()).toEqual([]);
    // Cancelled: not listed (its alistamiento is voided).
    cancelled = await confirmedOrder(h, [{ productId: product, qty: 1 }]);
    await h.run("sales.order.cancel", { id: cancelled.id, reason: "El cliente desistió" });
    expect(await h.drain()).toEqual([]);
    // Only a service: nothing to pick.
    serviceOnly = await confirmedOrder(h, [{ productId: service, qty: 1 }]);
    // Not confirmed: not listed.
    draft = (await h.run<{ id: string }>("sales.order.create", { partyId: h.partyId, issueDate: h.day(3, 1), warehouseId: h.warehouseId, lines: [{ productId: product, qty: 1, unitPrice: 20000 }] })).id;
    // Without an alistamiento (the switch off): listed with none.
    await h.runStepUp("warehouse.settings.update", { autoPickOnConfirm: false });
    manual = await confirmedOrder(h, [{ productId: product, qty: 7 }]);
  }, 300_000);

  afterAll(async () => {
    registerCatalogue(undefined);
    await h.cleanup();
  });

  it("lists the confirmed pedidos with goods still to pick and no confirmed alistamiento, oldest first, with the open alistamiento", async () => {
    const out = await report();
    expect(out.rows.map((r) => r.order_id)).toEqual([open.id, manual.id]);
    const [first, second] = out.rows;
    const [openPick] = await h.sql<{ id: string; number: string }[]>`select id, number from warehouse.picks where order_id = ${open.id}`;
    expect(first).toMatchObject({
      order_number: await numberOf(open.id), party_id: h.partyId, party_name: expect.stringContaining("Distribuidora"), warehouse_name: "Bodega principal",
      lines: 1, qty_pending: 4, pick_id: openPick!.id, pick_number: openPick!.number, pick_stage: "Por alistar",
    });
    expect(typeof first!.confirmed_at).toBe("string");
    expect(second).toMatchObject({ order_number: await numberOf(manual.id), lines: 1, qty_pending: 7, pick_id: null, pick_number: null, pick_stage: null });
    for (const id of [picked.id, cancelled.id, draft, serviceOnly.id]) expect(out.rows.map((r) => r.order_id)).not.toContain(id);
    expect(out.total).toBe(2);
  });

  it("narrows by bodega and by the confirmation date, and refuses a reversed range", async () => {
    expect((await report({ warehouseId: h.warehouseId })).total).toBe(2);
    const other = (await h.run<{ id: string }>("inventory.warehouse.create", { code: `OT${randomUUID().slice(0, 4)}`, name: "Otra bodega", allowBackorders: false })).id;
    expect((await report({ warehouseId: other })).total).toBe(0);
    const [today] = await h.sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`;
    expect((await report({ from: today!.d, to: today!.d })).total).toBe(2);
    expect((await report({ to: `${h.year - 1}-12-31` })).total).toBe(0);
    expect((await h.refusal(report({ from: "2026-12-31", to: "2026-01-01" })))?.code).toBe("invalid_input");
  });

  it("drops a pedido once its alistamiento is confirmed", async () => {
    const [openPick] = await h.sql<{ id: string }[]>`select id from warehouse.picks where order_id = ${open.id}`;
    await h.run("warehouse.pick.confirm", { id: openPick!.id });
    expect(await h.drain()).toEqual([]);
    expect((await report()).rows.map((r) => r.order_id)).toEqual([manual.id]);
  });
});
