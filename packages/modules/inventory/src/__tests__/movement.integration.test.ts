import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessContext, Tx } from "@erp/kernel";
import { applyStock } from "../processes/movement";
import { inventoryHarness, newId, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// inventory.movement.post (plan 2B Task 6, Review Focus 1): stock never goes negative or double-moves. One transaction writes the
// movement, its lines and the stock levels under `select … for update`; the refusals lead with their code (negative_stock_refused,
// service_product_refused); a redelivered event posts one movement (idempotency key = the source line ids).

type Posted = { id: string | null; number: string | null; status: string; skippedLines: number };

describe("inventory movements", () => {
  let h: InventoryHarness;

  beforeAll(async () => {
    h = await inventoryHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const post = (input: Record<string, unknown>) => h.run<Posted>(h.admin, "inventory.movement.post", input);
  const today = "2026-11-04";

  it("a receipt then an issue leave the right on-hand, numbered on save, with one movement.posted event each", async () => {
    const productId = await product(h, h.admin, "MOV-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "B1");
    const receipt = await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 10, unitCost: 16200 }] });
    expect(receipt).toMatchObject({ status: "saved", skippedLines: 0 });
    expect(receipt.number).toMatch(/^EN-\d+$/);
    const issue = await post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -4 }] });
    expect(issue.number).toMatch(/^SA-\d+$/);
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 6, reserved: 0, available: 6 });

    const [row] = await h.sql`select status, number, requires_approval, posts, applied_at is not null as applied from inventory.movements where id = ${receipt.id}`;
    expect(row).toMatchObject({ status: "saved", number: receipt.number, requires_approval: false, posts: false, applied: true });
    const events = await h.sql<{ payload: Record<string, unknown> }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'inventory.movement.posted' and payload->>'movementId' = ${receipt.id!}`;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      movementId: receipt.id,
      number: receipt.number,
      kind: "receipt",
      date: today,
      warehouseId,
      lines: [{ productId, warehouseId, locationId, qty: 10, uom: "94", unitCost: 16200 }],
    });
  });

  it("refuses an issue that leaves stock below zero, unless the bodega allows backorders", async () => {
    const productId = await product(h, h.admin, "MOV-2");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "B2");
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 2 }] });
    await expect(post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -3 }] })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/^negative_stock_refused:/),
    });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 2 });
    expect((await h.sql`select 1 from inventory.movements where warehouse_id = ${warehouseId}`).length).toBe(1);

    const backorders = await warehouse(h, h.admin, "B2X", { allowBackorders: true });
    await post({ kind: "issue", date: today, warehouseId: backorders.id, lines: [{ productId, locationId: backorders.locationId, qty: -3 }] });
    expect(await stockOf(h, productId, backorders.id)).toMatchObject({ onHand: -3 });
  });

  it("two concurrent issues of the last unit: one succeeds, the other is refused with negative_stock_refused", async () => {
    const productId = await product(h, h.admin, "MOV-3");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "B3");
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 1 }] });
    const results = await Promise.allSettled([
      post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -1 }] }),
      post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -1 }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^negative_stock_refused:/) });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 0 });
  });

  it("a track_stock=false product moves nothing; a service is refused with kind=service", async () => {
    const untracked = await product(h, h.admin, "MOV-4", { trackStock: false });
    const tracked = await product(h, h.admin, "MOV-5");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "B4");

    const nothing = await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId: untracked, locationId, qty: 5 }] });
    expect(nothing).toEqual({ id: null, number: null, status: "skipped", skippedLines: 1 });
    expect((await h.sql`select 1 from inventory.movements where warehouse_id = ${warehouseId}`).length).toBe(0);
    expect((await h.sql`select 1 from inventory.stock_levels where product_id = ${untracked}`).length).toBe(0);

    const mixed = await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId: untracked, locationId, qty: 5 }, { productId: tracked, locationId, qty: 7 }] });
    expect(mixed).toMatchObject({ status: "saved", skippedLines: 1 });
    expect((await h.sql`select product_id from inventory.movement_lines where movement_id = ${mixed.id}`).map((r) => r.product_id)).toEqual([tracked]);
    expect(await stockOf(h, tracked, warehouseId)).toMatchObject({ onHand: 7 });

    const service = await product(h, h.admin, "SRV-1", { kind: "service", trackStock: false, uomCode: "94" });
    await expect(post({ kind: "issue", date: today, warehouseId, lines: [{ productId: service, locationId, qty: -1 }] })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/^service_product_refused:/),
    });
  });

  it("refuses the wrong sign for the kind, a ubicación of another bodega and a unit other than the product's", async () => {
    const productId = await product(h, h.admin, "MOV-6");
    const a = await warehouse(h, h.admin, "B5");
    const b = await warehouse(h, h.admin, "B6");
    await expect(post({ kind: "receipt", date: today, warehouseId: a.id, lines: [{ productId, locationId: a.locationId, qty: -1 }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(post({ kind: "issue", date: today, warehouseId: a.id, lines: [{ productId, locationId: a.locationId, qty: 1 }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(post({ kind: "receipt", date: today, warehouseId: a.id, lines: [{ productId, locationId: b.locationId, qty: 1 }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(post({ kind: "receipt", date: today, warehouseId: a.id, lines: [{ productId, locationId: a.locationId, qty: 1, uom: "KGM" }] })).rejects.toMatchObject({ code: "invalid_input" });
    // Ajustes y traslados have their own processes (Task 7): adjustment.post is a step-up process.
    await expect(post({ kind: "adjustment", date: today, warehouseId: a.id, lines: [{ productId, locationId: a.locationId, qty: 1 }] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a redelivered event posts one movement: the idempotency key is the source line id", async () => {
    const productId = await product(h, h.admin, "MOV-7");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "B7");
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 10 }] });
    const deliveryId = newId();
    const lineId = newId();
    const input = { kind: "sale_issue", date: today, warehouseId, sourceEntity: "sales.delivery", sourceId: deliveryId, lines: [{ productId, locationId, qty: -3, sourceLineId: lineId }] };

    const first = (await h.consumer().runProcess("inventory.movement.post", input)) as Posted;
    // The same event delivered again (another delivery attempt, its own consumer context) answers the first movement.
    const again = (await h.consumer().runProcess("inventory.movement.post", input)) as Posted;
    expect(again.id).toBe(first.id);
    expect(again.number).toBe(first.number);
    // A different payload naming the same source line still moves nothing more.
    const changed = (await h.consumer().runProcess("inventory.movement.post", { ...input, lines: [{ ...input.lines[0]!, qty: -5 }] })) as Posted;
    expect(changed.id).toBe(first.id);

    expect((await h.sql`select 1 from inventory.movement_lines where source_entity = 'sales.delivery' and source_line_id = ${lineId}`).length).toBe(1);
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 7 });
    expect((await h.sql`select 1 from kernel.outbox where event = 'inventory.movement.posted' and payload->>'movementId' = ${first.id!}`).length).toBe(1);
    // Run by the event consumer: origin event, the system user.
    const [audit] = await h.sql`select origin from kernel.audit_log where process_id = 'inventory.movement.post' and row_id = ${first.id!} order by occurred_at limit 1`;
    expect(audit?.origin).toBe("event");
  });

  it("Anular reverses the stock of a movement, and is refused when the reversal would leave stock below zero", async () => {
    const productId = await product(h, h.admin, "MOV-8");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "B8");
    const receipt = await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 5 }] });
    const issue = await post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -2 }] });

    const voided = await h.run<{ status: string }>(h.admin, "inventory.movement.void", { id: issue.id, reason: "Salida registrada por error" });
    expect(voided.status).toBe("voided");
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 5 });
    expect((await h.sql`select 1 from kernel.outbox where event = 'inventory.movement.voided' and payload->>'movementId' = ${issue.id!}`).length).toBe(1);
    // Already voided: Anular again is refused by the lifecycle.
    await expect(h.run(h.admin, "inventory.movement.void", { id: issue.id, reason: "otra vez" })).rejects.toMatchObject({ code: "invalid_state" });

    await post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -4 }] });
    await expect(h.run(h.admin, "inventory.movement.void", { id: receipt.id, reason: "Entrada duplicada" })).rejects.toMatchObject({
      message: expect.stringMatching(/^negative_stock_refused:/),
    });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 1 });
  });

  it("a movement in the inventory is immutable: Grabar with changes is refused and its lines cannot be written", async () => {
    const productId = await product(h, h.admin, "MOV-9");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "B9");
    const receipt = await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 5 }] });
    await expect(h.run(h.admin, "inventory.movement.save", { id: receipt.id, data: { description: "otra" } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = origin`;
        await tx`update inventory.movement_lines set qty = 50 where movement_id = ${receipt.id}`;
      }),
    ).rejects.toThrow(/movimiento/);
  });

  it("stock rows draw no seq they do not keep (rule 7): a bucket keeps its seq and the counter equals the row count", async () => {
    const productId = await product(h, h.admin, "SEQ-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "BS1");
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 5 }] });
    const [before] = await h.sql<{ seq: string }[]>`select seq from inventory.stock_levels where product_id = ${productId} and warehouse_id = ${warehouseId}`;
    await post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -2 }] });
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 1 }] });
    const rows = await h.sql<{ seq: string }[]>`select seq from inventory.stock_levels where product_id = ${productId} and warehouse_id = ${warehouseId}`;
    expect(rows).toEqual([{ seq: before!.seq }]);
    const [counter] = await h.sql<{ issued: string; rows: string; max: string }[]>`
      select (select next - 1 from core.entity_sequences where company_id = ${h.companyId} and entity = 'inventory.stock_level')::text as issued,
             (select count(*) from inventory.stock_levels where company_id = ${h.companyId})::text as rows,
             (select max(seq) from inventory.stock_levels where company_id = ${h.companyId})::text as max`;
    expect(counter).toEqual({ issued: counter!.rows, rows: counter!.rows, max: counter!.rows });
  });

  it("a movement of a source document is voided only by the source's event; a manual one by the UI", async () => {
    const productId = await product(h, h.admin, "VOID-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "BV1");
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 10 }] });
    const input = { kind: "sale_issue", date: today, warehouseId, sourceEntity: "sales.delivery", sourceId: newId(), lines: [{ productId, locationId, qty: -4, sourceLineId: newId() }] };
    const issued = (await h.consumer().runProcess("inventory.movement.post", input)) as Posted;

    await expect(h.run(h.admin, "inventory.movement.void", { id: issued.id, reason: "desde la pantalla" })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/^source_linked_movement:/),
    });
    await expect(h.run({ ...h.admin, origin: "agent" }, "inventory.movement.void", { id: issued.id, reason: "el asistente" })).rejects.toMatchObject({
      message: expect.stringMatching(/^source_linked_movement:/),
    });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 6 });

    // The delivery's own event (its void) undoes it.
    const voided = (await h.consumer("sales.delivery.voided").runProcess("inventory.movement.void", { id: issued.id, reason: "Entrega anulada" })) as { status: string };
    expect(voided.status).toBe("voided");
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 10 });
    // A redelivery of the shipped event afterwards answers the movement as it is now: voided, nothing moves again.
    expect(await h.consumer().runProcess("inventory.movement.post", input)).toMatchObject({ id: issued.id, status: "voided" });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 10 });

    // A manual issue (no source) is still voidable from the UI.
    const manual = await post({ kind: "issue", date: today, warehouseId, lines: [{ productId, locationId, qty: -1 }] });
    await expect(h.run(h.admin, "inventory.movement.void", { id: manual.id, reason: "error" })).resolves.toMatchObject({ status: "voided" });
  });

  it("a request naming source lines that already moved with others is refused, not answered as a redelivery", async () => {
    const productId = await product(h, h.admin, "DUP-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "BD1");
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 10 }] });
    const lineA = newId();
    const base = { kind: "sale_issue", date: today, warehouseId, sourceEntity: "sales.delivery", sourceId: newId() };
    await h.consumer().runProcess("inventory.movement.post", { ...base, lines: [{ productId, locationId, qty: -1, sourceLineId: lineA }] });
    await expect(
      h.consumer().runProcess("inventory.movement.post", { ...base, lines: [{ productId, locationId, qty: -1, sourceLineId: lineA }, { productId, locationId, qty: -2, sourceLineId: newId() }] }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/^duplicate_source_line:/) });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 9 });
  });

  it("a movement over two ubicaciones and reservations of the same product run concurrently without a deadlock", async () => {
    const productId = await product(h, h.admin, "LCK-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "BL1");
    const second = await h.run<{ id: string }>(h.admin, "inventory.location.create", { warehouseId, code: "B2", name: "Estante B2" });
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 50 }, { productId, locationId: second.id, qty: 50 }] });
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      // Opposite ubicación order in the request: the lock order does not depend on it.
      const lines = i % 2 === 0
        ? [{ productId, locationId, qty: -1 }, { productId, locationId: second.id, qty: -1 }]
        : [{ productId, locationId: second.id, qty: -1 }, { productId, locationId, qty: -1 }];
      runs.push(post({ kind: "issue", date: today, warehouseId, lines }));
      runs.push(h.run(h.admin, "inventory.reservation.create", { sourceEntity: "sales.order", sourceLineId: newId(), productId, warehouseId, qty: 1 }));
    }
    const results = await Promise.allSettled(runs);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 92, reserved: 4, available: 88 });
  });

  // The stock update itself (on_hand = on_hand + qty) already queues two writers of one row; the explicit locks are what a READER of the
  // stock needs: a reservation must not read the on-hand an uncommitted issue is about to change.
  it("applyStock holds the product's stock until commit: a reservation waits, then sees the committed on-hand", async () => {
    const productId = await product(h, h.admin, "LCK-2");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "BL2");
    await post({ kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 1 }] });
    const wh = { id: warehouseId, allowBackorders: false };
    const delta = [{ productId, locationId, qty: -1, sku: "LCK-2" }];
    const ctxOf = (tx: Tx) => ({ tx, companyId: h.companyId }) as unknown as ProcessContext;
    const inProcess = (tx: Tx) => tx`select set_config('erp.audit_process_id', 'inventory.movement.post', true)`;

    let commitA!: () => void;
    const gate = new Promise<void>((resolve) => (commitA = resolve));
    let lockedA!: () => void;
    const aLocked = new Promise<void>((resolve) => (lockedA = resolve));
    const a = h.sql.begin(async (tx) => {
      await inProcess(tx as unknown as Tx);
      await applyStock(ctxOf(tx as unknown as Tx), wh, delta);
      lockedA();
      await gate;
    });
    await aLocked;
    let bSettled = false;
    const b = h
      .run(h.admin, "inventory.reservation.create", { sourceEntity: "sales.order", sourceLineId: newId(), productId, warehouseId, qty: 1 })
      .finally(() => (bSettled = true));
    b.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const waited = !bSettled;
    // Commit A before asserting, so a failure never leaves its transaction open.
    commitA();
    await a;
    expect(waited).toBe(true);
    await expect(b).rejects.toMatchObject({ message: expect.stringMatching(/^reservation_exceeds_available:/) });
    expect(await stockOf(h, productId, warehouseId)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  it("company isolation: another company sees none of the movements or stock", async () => {
    const rows = await h.run<{ id: string }>(h.other, "inventory.movement.consult", { id: (await h.sql`select id from inventory.movements where company_id = ${h.companyId} limit 1`)[0]!.id }).catch((e: unknown) => e);
    expect(rows).toMatchObject({ code: "not_found" });
  });
});
