import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel";
import { inventoryHarness, newId, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// Stock levels and reservations (plan 2B Task 6): inventory.v_stock publishes on hand, reserved and available per product, bodega and
// ubicación for the other modules (sales reads it, Task 13); inventory.reservation.create / release are event-callable, idempotent on the
// source line and refuse a reservation beyond what is available.

type Reservation = { id: string | null; status: string; reserved: number };

describe("inventory stock levels and reservations", () => {
  let h: InventoryHarness;
  const today = "2026-11-04";

  beforeAll(async () => {
    h = await inventoryHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const receive = (warehouseId: string, locationId: string, productId: string, qty: number) =>
    h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty }] });
  const reserve = (input: Record<string, unknown>) => h.run<Reservation>(h.admin, "inventory.reservation.create", input);
  const release = (input: Record<string, unknown>) => h.run<Reservation>(h.admin, "inventory.reservation.release", input);

  it("v_stock shows on hand per ubicación with the columns sales reads, and only the caller's company", async () => {
    const productId = await product(h, h.admin, "STK-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "S1");
    const second = await h.run<{ id: string }>(h.admin, "inventory.location.create", { warehouseId, code: "B2", name: "Estante B2" });
    await receive(warehouseId, locationId, productId, 4);
    await receive(warehouseId, second.id, productId, 6);

    const rows = await withClaims(h.sql, h.admin.claims, (tx) => tx`
      select company_id, product_id, warehouse_id, location_id, on_hand::float8 as on_hand, reserved::float8 as reserved, available::float8 as available
      from inventory.v_stock where product_id = ${productId} order by on_hand`);
    expect(rows).toEqual([
      { company_id: h.companyId, product_id: productId, warehouse_id: warehouseId, location_id: locationId, on_hand: 4, reserved: 0, available: 4 },
      { company_id: h.companyId, product_id: productId, warehouse_id: warehouseId, location_id: second.id, on_hand: 6, reserved: 0, available: 6 },
    ]);
    const foreign = await withClaims(h.sql, h.other.claims, (tx) => tx`select 1 from inventory.v_stock where product_id = ${productId}`);
    expect(foreign).toHaveLength(0);
  });

  it("reserves within available, answers a repeated reservation of the same source line once, and refuses beyond available", async () => {
    const productId = await product(h, h.admin, "STK-2");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "S2");
    await receive(warehouseId, locationId, productId, 10);
    const orderLine = newId();
    const input = { sourceEntity: "sales.order", sourceLineId: orderLine, productId, warehouseId, qty: 6 };
    const first = await reserve(input);
    expect(first).toMatchObject({ status: "active", reserved: 6 });
    // Redelivered (the order event again, through the consumer): the same reservation, reserved once.
    const again = (await h.consumer("sales.order.confirmed").runProcess("inventory.reservation.create", input)) as Reservation;
    expect(again.id).toBe(first.id);
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 10, reserved: 6, available: 4 });

    await expect(reserve({ ...input, sourceLineId: newId(), qty: 5 })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/^reservation_exceeds_available:/),
    });
    await reserve({ ...input, sourceLineId: newId(), qty: 4 });
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 10, reserved: 10, available: 0 });
  });

  it("releases part, then the rest; releasing what is gone or never was changes nothing", async () => {
    const productId = await product(h, h.admin, "STK-3");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "S3");
    await receive(warehouseId, locationId, productId, 8);
    const sourceLineId = newId();
    await reserve({ sourceEntity: "sales.order", sourceLineId, productId, warehouseId, qty: 5 });

    expect(await release({ sourceEntity: "sales.order", sourceLineId, qty: 2 })).toMatchObject({ status: "active", reserved: 3 });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ reserved: 3, available: 5 });
    expect(await release({ sourceEntity: "sales.order", sourceLineId })).toMatchObject({ status: "released", reserved: 0 });
    expect(await release({ sourceEntity: "sales.order", sourceLineId })).toMatchObject({ status: "released", reserved: 0 });
    expect(await release({ sourceEntity: "sales.order", sourceLineId: newId() })).toEqual({ id: null, status: "absent", reserved: 0 });
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 8, reserved: 0, available: 8 });
  });

  it("two concurrent reservations of the last unit: one is taken, the other refused", async () => {
    const productId = await product(h, h.admin, "STK-4");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "S4");
    await receive(warehouseId, locationId, productId, 1);
    const results = await Promise.allSettled([
      reserve({ sourceEntity: "sales.order", sourceLineId: newId(), productId, warehouseId, qty: 1 }),
      reserve({ sourceEntity: "sales.order", sourceLineId: newId(), productId, warehouseId, qty: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 1, reserved: 1, available: 0 });
  });

  it("a product that does not keep stock reserves nothing", async () => {
    const productId = await product(h, h.admin, "STK-5", { trackStock: false });
    const { id: warehouseId } = await warehouse(h, h.admin, "S5");
    expect(await reserve({ sourceEntity: "sales.order", sourceLineId: newId(), productId, warehouseId, qty: 3 })).toEqual({ id: null, status: "not_tracked", reserved: 0 });
    expect((await h.sql`select 1 from inventory.reservations where product_id = ${productId}`).length).toBe(0);
  });

  it("a released source line can be reserved again; reservation seqs keep no gaps (rule 7)", async () => {
    const productId = await product(h, h.admin, "STK-7");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "S7");
    await receive(warehouseId, locationId, productId, 5);
    const input = { sourceEntity: "sales.order", sourceLineId: newId(), productId, warehouseId, qty: 3 };
    const first = await reserve(input);
    await release({ sourceEntity: input.sourceEntity, sourceLineId: input.sourceLineId });
    // The order is confirmed again after the cancel: a new reservation, the released one stays as history.
    const second = await reserve(input);
    expect(second).toMatchObject({ status: "active", reserved: 3 });
    expect(second.id).not.toBe(first.id);
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 5, reserved: 3, available: 2 });
    // While it is active, the line still answers its one reservation.
    expect((await reserve(input)).id).toBe(second.id);
    expect(await release({ sourceEntity: input.sourceEntity, sourceLineId: input.sourceLineId, qty: 1 })).toMatchObject({ id: second.id, status: "active", reserved: 2 });

    const [counter] = await h.sql<{ issued: string; rows: string; max: string }[]>`
      select (select next - 1 from core.entity_sequences where company_id = ${h.companyId} and entity = 'inventory.reservation')::text as issued,
             (select count(*) from inventory.reservations where company_id = ${h.companyId})::text as rows,
             (select max(seq) from inventory.reservations where company_id = ${h.companyId})::text as max`;
    expect(counter).toEqual({ issued: counter!.rows, rows: counter!.rows, max: counter!.rows });
  });

  it("stock levels are written only by the inventory processes: the restrictive policy hides every row from a direct write", async () => {
    const productId = await product(h, h.admin, "STK-6");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "S6");
    await receive(warehouseId, locationId, productId, 2);
    // The same user, the same company RLS: outside a process (no erp.audit_process_id) the update reaches no row …
    const outside = await withClaims(h.sql, h.admin.claims, (tx) => tx`update inventory.stock_levels set on_hand = 999 where product_id = ${productId} returning id`);
    expect(outside).toHaveLength(0);
    // … another module's process does not reach it either (the policy wants an inventory process) …
    const foreignProcess = await withClaims(h.sql, h.admin.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'sales.order.save', true)`;
      return tx`update inventory.stock_levels set on_hand = 999 where product_id = ${productId} returning id`;
    });
    expect(foreignProcess).toHaveLength(0);
    // … while inside an inventory process it does: the restrictive policy is the guard (the change is rolled back here).
    const marker = new Error("rollback");
    const inside = await withClaims(h.sql, h.admin.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'inventory.movement.post', true)`;
      const rows = await tx`update inventory.stock_levels set on_hand = 999 where product_id = ${productId} returning id`;
      throw Object.assign(marker, { rows: rows.length });
    }).catch((e: unknown) => e as Error & { rows?: number });
    expect(inside).toBe(marker);
    expect((inside as { rows?: number }).rows).toBe(1);
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 2 });
  });
});
