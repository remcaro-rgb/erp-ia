import { randomUUID } from "node:crypto";
import { buildConsumerContext, registerCatalogue, runReport } from "@erp/kernel";
import { translate } from "../../../../i18n/src/index";
import { openReportExport } from "@erp/kernel/exports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onDeliveryShipped, onReturnReceived } from "../processes/sales-deliveries";
import { inventoryHarness, newId, product, warehouse, type InventoryHarness } from "./helpers";

// The recall report «Trazabilidad de lotes» (plan 2B.2 Task 28.4, PG §3.6; rules 14, 17, 20, 21): inventory.report.lot_trace lists every
// movement of a lot (or a serial) with its date, kind, bodega, quantity, the movement (a link to its record, which links on to its source
// document) and the customer a sale issue or a return answered to (inventory.movements.party_id, written by the sale issue from the
// shipped event and by the return from the issue it returns: inventory reads no sales table, rule 3), then the stock on hand by bodega.
// A user whose role masks the movement's customer sees it empty. The report exports like any other (rule 20). The sales events are
// written by hand as sales emits them.

type Row = Record<string, unknown>;
interface Out { rows: Row[]; total: number; aggregates?: Record<string, unknown> }
const state = { filters: [], sort: [], page: 1, pageSize: 500 };

describe("inventory.report.lot_trace (Task 28.4)", () => {
  let h: InventoryHarness;
  let w: { id: string; locationId: string };
  let productId: string;
  let lotId: string;
  let otherLotId: string;
  let andina: string;
  let cumbre: string;

  const consumer = (event: string) => buildConsumerContext(h.sql, { id: randomUUID(), event, companyId: h.companyId, chainId: randomUUID(), createdAt: new Date() }, h.registry);
  const customer = async (documentNumber: string, legalName: string) => (await h.run<{ id: string }>(h.admin, "core.party.create", {
    kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
    countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
  })).id;
  const ship = async (partyId: string, qty: number, number: string) => {
    const deliveryId = newId();
    const lineId = newId();
    await onDeliveryShipped(consumer("sales.delivery.shipped"), { deliveryId, number, orderId: newId(), partyId, warehouseId: w.id, date: "2026-11-15", lines: [{ lineId, lineNo: 1, productId, qty }] });
    return { deliveryId, lineId };
  };
  const trace = (caller = h.admin, params: Record<string, unknown> = { lotId }) => runReport(h.deps, caller, "inventory.lot_trace", params, state) as Promise<Out>;

  beforeAll(async () => {
    // The servers register the app's catalogue (apps/web runtime): the report's kinds read as the user's words.
    registerCatalogue(translate);
    h = await inventoryHarness();
    w = await warehouse(h, h.admin, "TRZ");
    andina = await customer("860002964", "Distribuidora Andina S.A.S.");
    cumbre = await customer("900222333", "Hotel Cumbre Andina S.A.S.");
    productId = await product(h, h.admin, `TRZ-${randomUUID().slice(0, 5)}`);
    await h.runStepUp(h.admin, "inventory.product_tracking.set", { productId, tracking: "lot" });
    await h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: "2026-11-01", warehouseId: w.id, reference: "OC-77", lines: [
      { productId, locationId: w.locationId, qty: 10, unitCost: 1000, lot: { code: "L-2311", expiresOn: "2026-12-20" } },
      { productId, locationId: w.locationId, qty: 5, unitCost: 1000, lot: { code: "L-2402", expiresOn: "2027-03-15" } },
    ] });
    const lots = await h.sql<{ id: string; code: string }[]>`select id, code from inventory.lots where product_id = ${productId}`;
    lotId = lots.find((l) => l.code === "L-2311")!.id;
    otherLotId = lots.find((l) => l.code === "L-2402")!.id;
  });
  afterAll(async () => {
    registerCatalogue(undefined);
    await h.cleanup();
  });

  it("(3) a receipt, two deliveries to two customers and a return of lot L-2311: four movements with their customers and links, then the stock by bodega", async () => {
    await ship(andina, 4, "ENT-1");
    const second = await ship(cumbre, 3, "ENT-2");
    // The issue stored the customer on its movement (from the shipped event).
    const issues = await h.sql<{ party_id: string | null }[]>`select party_id from inventory.movements where company_id = ${h.companyId} and kind = 'sale_issue' order by seq`;
    expect(issues.map((m) => m.party_id)).toEqual([andina, cumbre]);
    // Cumbre returns 1: the return answers to the customer of the issue it returns.
    await onReturnReceived(consumer("sales.return.received"), { returnId: newId(), number: "DEV-1", warehouseId: w.id, date: "2026-11-18", lines: [{ lineId: newId(), deliveryLineId: second.lineId, productId, qty: 1, lotId }] });
    const [ret] = await h.sql<{ party_id: string | null }[]>`select party_id from inventory.movements where company_id = ${h.companyId} and kind = 'sale_return'`;
    expect(ret!.party_id).toBe(cumbre);

    const out = await trace();
    const moves = out.rows.filter((r) => r.row_kind === "movement");
    expect(moves.map((r) => [r.date, r.kind, r.qty, r.customer])).toEqual([
      ["2026-11-01", "Entrada", 10, null],
      ["2026-11-15", "Salida por venta", -4, "Distribuidora Andina S.A.S."],
      ["2026-11-15", "Salida por venta", -3, "Hotel Cumbre Andina S.A.S."],
      ["2026-11-18", "Devolución de venta", 1, "Hotel Cumbre Andina S.A.S."],
    ]);
    expect(moves.map((r) => r.reference)).toEqual(["OC-77", "ENT-1", "ENT-2", "DEV-1"]);
    expect(moves.every((r) => typeof r.movement_id === "string" && typeof r.number === "string")).toBe(true);
    expect(moves.map((r) => r.party_id)).toEqual([null, andina, cumbre, cumbre]);
    expect(moves.every((r) => r.warehouse === "Bodega TRZ" || typeof r.warehouse === "string")).toBe(true);
    // Stock on hand by bodega: 10 − 4 − 3 + 1 = 4 of L-2311 (L-2402 is another lot: not counted).
    const stock = out.rows.filter((r) => r.row_kind === "stock");
    expect(stock.map((r) => [r.kind, r.qty])).toEqual([["Existencia", 4]]);
    expect(out.aggregates).toMatchObject({ lotCode: "L-2311", expiresOn: "2026-12-20", onHand: 4 });
    // The other lot traces only its own receipt.
    const other = await trace(h.admin, { lotId: otherLotId });
    expect(other.rows.filter((r) => r.row_kind === "movement").map((r) => [r.kind, r.qty])).toEqual([["Entrada", 5]]);
    // A date range keeps the movements in it; the stock is today's.
    const ranged = await trace(h.admin, { lotId, from: "2026-11-10", to: "2026-11-16" });
    expect(ranged.rows.filter((r) => r.row_kind === "movement").map((r) => r.qty)).toEqual([-4, -3]);
  });

  it("(3) a user whose role masks the movement's customer sees the movements with no customer", async () => {
    const [role] = await h.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${h.companyId} and name = 'bodeguero'`;
    await h.sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${h.companyId}, ${role!.id}, 'inventory.movement', 'party_id', 'masked')`;
    const masked = await trace(h.member);
    const moves = masked.rows.filter((r) => r.row_kind === "movement");
    expect(moves).toHaveLength(4);
    expect(moves.every((r) => r.customer === null && r.party_id === null)).toBe(true);
    // The admin still sees them.
    expect((await trace()).rows.filter((r) => r.customer !== null && r.row_kind === "movement")).toHaveLength(3);
  });

  it("refuses a call naming neither or both a lot and a serial, and a lot of another company", async () => {
    await expect(trace(h.admin, {})).rejects.toMatchObject({ code: "invalid_input" });
    await expect(trace(h.admin, { lotId, serialId: newId() })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(trace(h.other, { lotId })).rejects.toMatchObject({ code: expect.stringMatching(/invalid_input|not_found/) });
  });

  it("a serial traces its receipt and its issue", async () => {
    const grinder = await product(h, h.admin, `MOL-${randomUUID().slice(0, 5)}`);
    await h.runStepUp(h.admin, "inventory.product_tracking.set", { productId: grinder, tracking: "serial" });
    await h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: "2026-11-02", warehouseId: w.id, lines: [{ productId: grinder, locationId: w.locationId, qty: 2, unitCost: 90000, serials: [{ serialNo: "MOL-0001" }, { serialNo: "MOL-0002" }] }] });
    const [sn] = await h.sql<{ id: string }[]>`select id from inventory.serials where product_id = ${grinder} and serial_no = 'MOL-0001'`;
    await onDeliveryShipped(consumer("sales.delivery.shipped"), { deliveryId: newId(), number: "ENT-9", orderId: newId(), partyId: andina, warehouseId: w.id, date: "2026-11-16", lines: [{ lineId: newId(), lineNo: 1, productId: grinder, qty: 1, serialIds: [sn!.id] }] });
    const out = await trace(h.admin, { serialId: sn!.id });
    expect(out.rows.filter((r) => r.row_kind === "movement").map((r) => [r.kind, r.qty, r.customer])).toEqual([["Entrada", 1, null], ["Salida por venta", -1, "Distribuidora Andina S.A.S."]]);
    expect(out.rows.filter((r) => r.row_kind === "stock")).toEqual([]);
  });

  it("(4) exports as CSV with the report's columns (rule 20)", async () => {
    const file = await openReportExport(h.deps, h.admin, { id: "inventory.lot_trace", params: { lotId }, format: "csv" });
    const text = await new Response(file.body as ReadableStream<Uint8Array>).text();
    expect(file.contentType).toMatch(/csv/);
    expect(text).toContain("Distribuidora Andina S.A.S.");
    expect(text).toContain("ENT-2");
    expect(text.split("\n").filter((l) => l.trim().length > 0).length).toBeGreaterThanOrEqual(6);
  });
});
