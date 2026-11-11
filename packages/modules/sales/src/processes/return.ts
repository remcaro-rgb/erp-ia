import { defineProcess, ProcessError, runLifecycle, writeSnapshot, type EventConsumer, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { returnEntity } from "../entities";
import { refuse, refuseState, today } from "./order";
import { lockShipStock, pendingShipped, qtyText } from "./stock";

// Devoluciones de ventas (plan 2B Task 14): goods a customer sends back from a shipped entrega, line by line against the entrega's lines,
// never more than was delivered (counting the other devoluciones that are not voided). A documento numbered DEV- on save that never posts
// itself. sales.return.receive emits sales.return.received { returnId, number, deliveryId, orderId, warehouseId, date, costCenterId?,
// lines[] }: inventory's consumer re-enters the stock (sale_return, `returnOf` naming the entrega line, so costing re-enters each unit at
// the cost its sale issue took, Task 8) and costing emits costing.cogs.returned, which the ledger posts (Dr inventory / Cr cogs). The
// pedido's stage does not change (what was delivered was delivered; the credit note is invoicing's, Task 18). Anular of a received
// devolución emits sales.return.voided: inventory voids the sale return and costing reverses it (and its cost of sales). Before it, under
// the same per bodega and product lock as a ship, the units it takes back must still be in the bucket they entered (inventory's
// inventory.source_line_stock, migration 0087), less what shipped entregas not yet issued may take; otherwise negative_stock_refused.
// When inventory still refuses the void (the stock left meanwhile), it emits inventory.sale_return_void.refused and
// sales.return.restore puts the devolución back to Grabado (received) with the reason in stock_refusal (Task 14 review).

const FEATURE = "sales.returns";
export const RETURN_RECEIVED = "sales.return.received";
export const RETURN_VOIDED = "sales.return.voided";
const SALE_RETURN_VOID_REFUSED = "inventory.sale_return_void.refused";
const NUMBER_PREFIX = "DEV-";
const WRITABLE = ["notes", "extra", "extra_free"];

const id = z.uuid();
const date = z.iso.date();
const qty = z.number().finite().positive().refine((n) => n < 1e14 && Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Cantidad fuera de rango o con más de cuatro decimales");
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

const returnOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  stage: z.string(),
  deliveryId: z.string(),
  date: z.string(),
  receivedAt: z.string().nullable(),
  lines: z.array(z.object({ id: z.string(), lineNo: z.number(), deliveryLineId: z.string(), productId: z.string(), qty: z.number() })),
});
type ReturnOutput = z.output<typeof returnOutput>;

interface DeliveryRow { id: string; number: string | null; status: string; stage: string; order_id: string; party_id: string; warehouse_id: string; date: string; cost_center_id: string | null }
interface ReturnRow { id: string; number: string | null; status: string; stage: string; delivery_id: string; order_id: string; warehouse_id: string; date: string; cost_center_id: string | null; reason: string }
interface ReturnLineRow { id: string; line_no: number; delivery_line_id: string; product_id: string; qty: string; lot_id: string | null; serial_ids: string[] | null }
/** The columns of a ReturnLineRow, as a fragment of the caller's query. */
const lineColumns = (tx: ProcessContext["tx"]) => tx`id, line_no, delivery_line_id, product_id, qty::text, lot_id, serial_ids::text[] as serial_ids`;

const label = (r: { number: string | null; id: string }) => r.number ?? r.id;

/**
 * The entrega's pedido locked first, then the entrega (the lock order of delivery.ts), or `not_found`. The pedido is read under its owner
 * isolation (migration 0139, owner item 119(a)): a salesperson who neither owns it nor may run sales.order.reassign finds no pedido, so no
 * devolución of its entregas is created, received or voided (every devolución of an entrega is made under this lock).
 */
async function lockDelivery(ctx: ProcessContext, deliveryId: string): Promise<DeliveryRow> {
  const [head] = await ctx.tx<{ order_id: string }[]>`select order_id from sales.deliveries where id = ${deliveryId}`;
  if (!head) throw new ProcessError("not_found", `delivery ${deliveryId} not found`);
  const [order] = await ctx.tx<{ id: string }[]>`select id from sales.orders where id = ${head.order_id} for update`;
  if (!order) throw new ProcessError("not_found", `delivery ${deliveryId} not found`);
  const [row] = await ctx.tx<DeliveryRow[]>`
    select id, number, status, stage, order_id, party_id, warehouse_id, date::text, cost_center_id from sales.deliveries where id = ${deliveryId} for update`;
  if (!row) throw new ProcessError("not_found", `delivery ${deliveryId} not found`);
  return row;
}

function assertReturnable(delivery: DeliveryRow): void {
  if (delivery.status === "voided") refuseState("delivery_voided", [`La entrega ${label(delivery)} está anulada`]);
  if (delivery.stage !== "shipped") refuseState("delivery_not_shipped", [`La entrega ${label(delivery)} no se ha despachado: no hay nada que devolver`]);
}

/** Per entrega line, what the entrega's devoluciones that are not voided return, except `exceptId`. */
async function returnedByLine(ctx: ProcessContext, deliveryId: string, exceptId: string | null): Promise<Map<string, number>> {
  const rows = await ctx.tx<{ delivery_line_id: string; qty: string }[]>`
    select l.delivery_line_id, sum(l.qty)::text as qty from sales.return_lines l join sales.returns r on r.id = l.return_id
    where r.delivery_id = ${deliveryId} and r.status <> 'voided' and r.id is distinct from ${exceptId}::uuid
    group by l.delivery_line_id`;
  return new Map(rows.map((r) => [r.delivery_line_id, num(r.qty)]));
}

async function outputOf(ctx: ProcessContext, returnId: string): Promise<ReturnOutput> {
  const [row] = await ctx.tx<{ id: string; number: string | null; status: string; stage: string; delivery_id: string; date: string; received_at: string | null }[]>`
    select id, number, status, stage, delivery_id, date::text, to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at
    from sales.returns where id = ${returnId}`;
  if (!row) throw new ProcessError("not_found", `return ${returnId} not found`);
  const lines = await ctx.tx<ReturnLineRow[]>`select ${lineColumns(ctx.tx)} from sales.return_lines where return_id = ${returnId} order by line_no`;
  return {
    id: row.id, number: row.number, status: row.status, stage: row.stage, deliveryId: row.delivery_id, date: row.date, receivedAt: row.received_at,
    lines: lines.map((l) => ({ id: l.id, lineNo: l.line_no, deliveryLineId: l.delivery_line_id, productId: l.product_id, qty: num(l.qty) })),
  };
}

export const returnCreate = defineProcess({
  id: "sales.return.create",
  module: "sales",
  kind: "create",
  feature: FEATURE,
  description:
    "Crea una devolución de una entrega despachada con su motivo: por defecto todo lo entregado que no se ha devuelto, o las líneas y cantidades indicadas, sin pasar de lo entregado; le asigna su número DEV-. La mercancía vuelve al inventario al recibirla",
  input: z.object({
    deliveryId: id,
    reason: z.string().trim().min(1, "Indica por qué devuelve el cliente").max(500),
    /** The day the goods come back (default today). */
    date: date.optional(),
    /** The cost center of the cost of sales taken back (accounting's id); default the entrega's. */
    costCenterId: id.optional(),
    notes: z.string().trim().max(2000).optional(),
    /** Task 28.3: a lot product's line may name the lot coming back, a serial product's the serials; else they default from what the entrega issued. */
    lines: z.array(z.object({ deliveryLineId: id, qty, lotId: id.optional(), serialIds: z.array(id).min(1).max(500).optional() }).strict()).min(1).max(200).optional(),
  }).strict(),
  output: returnOutput,
  handler: async (ctx, input) => {
    const delivery = await lockDelivery(ctx, input.deliveryId);
    assertReturnable(delivery);
    const on = input.date ?? (await today(ctx));
    if (on < delivery.date) refuse("invalid_return_date", ["La fecha de la devolución es anterior a la de la entrega"]);
    const deliveryLines = await ctx.tx<{ id: string; line_no: number; product_id: string; qty: string }[]>`
      select id, line_no, product_id, qty::text from sales.delivery_lines where delivery_id = ${delivery.id} order by line_no`;
    const returned = await returnedByLine(ctx, delivery.id, null);
    const left = (l: { id: string; qty: string }) => round4(num(l.qty) - (returned.get(l.id) ?? 0));
    let lines: { line: (typeof deliveryLines)[number]; qty: number; lotId?: string | undefined; serialIds?: string[] | undefined }[];
    if (!input.lines) {
      lines = deliveryLines.filter((l) => left(l) > 0).map((l) => ({ line: l, qty: left(l) }));
      if (lines.length === 0) refuseState("nothing_to_return", [`De la entrega ${label(delivery)} ya se devolvió todo`]);
    } else {
      const byId = new Map(deliveryLines.map((l) => [l.id, l]));
      const problems: string[] = [];
      const over: string[] = [];
      const seen = new Set<string>();
      lines = [];
      input.lines.forEach((a, i) => {
        const line = byId.get(a.deliveryLineId);
        if (!line) return problems.push(`Línea ${i + 1}: la línea no es de la entrega ${label(delivery)}`);
        if (seen.has(line.id)) return problems.push(`Línea ${i + 1}: la línea ${line.line_no} de la entrega aparece dos veces`);
        seen.add(line.id);
        if (a.qty > left(line)) {
          return over.push(`Línea ${i + 1}: se entregaron ${qtyText(num(line.qty))}, ya se devolvieron ${qtyText(returned.get(line.id) ?? 0)} y quedan ${qtyText(Math.max(left(line), 0))}; la devolución pide ${qtyText(a.qty)}`);
        }
        lines.push({ line, qty: a.qty, lotId: a.lotId, serialIds: a.serialIds });
      });
      if (problems.length > 0) refuse("invalid_delivery_line", problems);
      if (over.length > 0) refuse("over_return", over);
    }
    const tracked = await lotsOfLines(ctx, delivery.id, lines);
    const [header] = await ctx.tx<{ id: string }[]>`
      insert into sales.returns ${ctx.tx({
        company_id: ctx.companyId,
        delivery_id: delivery.id,
        order_id: delivery.order_id,
        party_id: delivery.party_id,
        warehouse_id: delivery.warehouse_id,
        date: on,
        stage: "open",
        reason: input.reason,
        cost_center_id: input.costCenterId ?? delivery.cost_center_id,
        notes: input.notes ?? null,
        requires_approval: false,
        posts: false,
      })}
      returning id`;
    await ctx.tx`insert into sales.return_lines ${ctx.tx(lines.map((l, i) => ({
      company_id: ctx.companyId, return_id: header!.id, line_no: i + 1, delivery_line_id: l.line.id, product_id: l.line.product_id, qty: l.qty,
      lot_id: tracked[i]!.lotId, serial_ids: tracked[i]!.serialIds,
    })))}`;
    await runLifecycle(ctx, ctx.registry.entity(returnEntity.id), header!.id, "save");
    return outputOf(ctx, header!.id);
  },
});

/**
 * The lot or serials of each devolución line (Task 28.3), checked against what the entrega issued (sales.delivery_line_lots): a named lot
 * or serial must have left on that entrega line (invalid_delivery_line); an unnamed line of an entrega line that left from ONE lot takes
 * that lot, one that left by serial takes the serials not returned yet (serials_required when fewer remain); an entrega line that left from
 * several lots names none and inventory brings the units back to the lots the issue took, in its order. An untracked line names nothing.
 */
async function lotsOfLines(ctx: ProcessContext, deliveryId: string, lines: { line: { id: string; line_no: number }; qty: number; lotId?: string | undefined; serialIds?: string[] | undefined }[]) {
  const issued = await ctx.tx<{ delivery_line_id: string; lot_id: string | null; serial_id: string | null }[]>`
    select x.delivery_line_id, x.lot_id, x.serial_id from sales.delivery_line_lots x join sales.delivery_lines l on l.id = x.delivery_line_id
    where l.delivery_id = ${deliveryId} order by x.seq`;
  const returnedSerials = new Set((await ctx.tx<{ serial_id: string }[]>`
    select unnest(rl.serial_ids)::text as serial_id from sales.return_lines rl join sales.returns r on r.id = rl.return_id
    where r.delivery_id = ${deliveryId} and r.status <> 'voided' and rl.serial_ids is not null`).map((r) => r.serial_id));
  const problems: string[] = [];
  const missing: string[] = [];
  const out = lines.map((l, i) => {
    const ofLine = issued.filter((x) => x.delivery_line_id === l.line.id);
    const lots = [...new Set(ofLine.flatMap((x) => (x.lot_id ? [x.lot_id] : [])))];
    const serials = ofLine.flatMap((x) => (x.serial_id ? [x.serial_id] : []));
    if (l.lotId) {
      if (!lots.includes(l.lotId)) problems.push(`Línea ${i + 1}: ese lote no salió en la línea ${l.line.line_no} de la entrega`);
      return { lotId: l.lotId, serialIds: null };
    }
    if (l.serialIds) {
      if (l.serialIds.length !== l.qty || l.serialIds.some((s) => !serials.includes(s) || returnedSerials.has(s))) {
        problems.push(`Línea ${i + 1}: indica un serial por unidad, de los que salieron en la línea ${l.line.line_no} de la entrega y no se han devuelto`);
      }
      return { lotId: null, serialIds: l.serialIds };
    }
    if (serials.length > 0) {
      const left = serials.filter((s) => !returnedSerials.has(s)).slice(0, l.qty);
      if (left.length !== l.qty) missing.push(`Línea ${i + 1}: indica los seriales que vuelven`);
      for (const s of left) returnedSerials.add(s);
      return { lotId: null, serialIds: left.length > 0 ? left : null };
    }
    return { lotId: lots.length === 1 ? lots[0]! : null, serialIds: null };
  });
  if (problems.length > 0) refuse("invalid_delivery_line", problems);
  if (missing.length > 0) refuse("serials_required", missing);
  return out;
}

async function lockReturn(ctx: ProcessContext, returnId: string): Promise<{ delivery: DeliveryRow; ret: ReturnRow }> {
  const [head] = await ctx.tx<{ delivery_id: string }[]>`select delivery_id from sales.returns where id = ${returnId}`;
  if (!head) throw new ProcessError("not_found", `return ${returnId} not found`);
  const delivery = await lockDelivery(ctx, head.delivery_id);
  const [ret] = await ctx.tx<ReturnRow[]>`
    select id, number, status, stage, delivery_id, order_id, warehouse_id, date::text, cost_center_id, reason from sales.returns where id = ${returnId} for update`;
  return { delivery, ret: ret! };
}

export const returnReceive = defineProcess({
  id: "sales.return.receive",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  emits: [RETURN_RECEIVED],
  description:
    "Recibe una devolución grabada: la mercancía vuelve al inventario de la bodega al costo con que salió en la entrega y ese costo sale del costo de ventas",
  input: z.object({ id, idempotencyKey: z.string().trim().min(1).max(100).optional() }).strict(),
  output: returnOutput,
  auditInput: (input) => ({ id: input.id }),
  idempotencyKey: (input) => (input.idempotencyKey ? `receive:${input.id}:${input.idempotencyKey}` : undefined),
  handler: async (ctx, { id: returnId }) => {
    const { delivery, ret } = await lockReturn(ctx, returnId);
    if (ret.status === "voided") refuseState("return_voided", [`La devolución ${label(ret)} está anulada`]);
    if (ret.stage === "received") refuseState("return_received", [`La devolución ${label(ret)} ya se recibió`]);
    if (ret.status !== "saved") refuseState("return_not_saved", [`La devolución ${label(ret)} no está grabada`]);
    assertReturnable(delivery);
    const lines = await ctx.tx<ReturnLineRow[]>`select ${lineColumns(ctx.tx)} from sales.return_lines where return_id = ${returnId} order by line_no`;
    // Under the entrega's lock, once more: the other devoluciones that are not voided plus this one never exceed what was delivered.
    const delivered = new Map((await ctx.tx<{ id: string; qty: string }[]>`select id, qty::text from sales.delivery_lines where delivery_id = ${delivery.id}`).map((l) => [l.id, num(l.qty)] as const));
    const returned = await returnedByLine(ctx, delivery.id, returnId);
    const over = lines.flatMap((l) =>
      round4((returned.get(l.delivery_line_id) ?? 0) + num(l.qty)) > (delivered.get(l.delivery_line_id) ?? 0)
        ? [`Línea ${l.line_no}: se devuelven más unidades de las que se entregaron`]
        : [],
    );
    if (over.length > 0) refuse("over_return", over);

    await ctx.tx`update sales.returns set stage = 'received', received_at = now() where id = ${returnId}`;
    await writeSnapshot(ctx, ctx.registry.entity(returnEntity.id), returnId, "saved", null);
    await ctx.emit(RETURN_RECEIVED, {
      returnId,
      number: ret.number,
      deliveryId: delivery.id,
      orderId: ret.order_id,
      warehouseId: ret.warehouse_id,
      date: ret.date,
      reason: ret.reason,
      ...(ret.cost_center_id ? { costCenterId: ret.cost_center_id } : {}),
      lines: lines.map((l) => ({
        lineId: l.id, lineNo: l.line_no, deliveryLineId: l.delivery_line_id, productId: l.product_id, qty: num(l.qty),
        ...(l.lot_id ? { lotId: l.lot_id } : {}),
        ...(l.serial_ids && l.serial_ids.length > 0 ? { serialIds: l.serial_ids } : {}),
      })),
    });
    return outputOf(ctx, returnId);
  },
});

export const returnVoid = defineProcess({
  id: "sales.return.void",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  emits: [RETURN_VOIDED],
  description: "Anula una devolución con su motivo; si ya se recibió, la mercancía vuelve a salir del inventario y se reversa el costo devuelto",
  input: z.object({ id, reason: z.string().trim().min(1, "Indica por qué se anula la devolución").max(500), expectedUpdatedAt: z.string().optional() }).strict(),
  output: returnOutput,
  handler: async (ctx, input) => {
    const { ret } = await lockReturn(ctx, input.id);
    if (ret.status === "voided") refuseState("return_voided", [`La devolución ${label(ret)} ya está anulada`]);
    if (ret.stage === "received") await assertStockBack(ctx, ret);
    await runLifecycle(ctx, ctx.registry.entity(returnEntity.id), ret.id, "void", { reason: input.reason, ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}) });
    if (ret.stage === "received") {
      const lines = await ctx.tx<ReturnLineRow[]>`select ${lineColumns(ctx.tx)} from sales.return_lines where return_id = ${ret.id} order by line_no`;
      await ctx.emit(RETURN_VOIDED, {
        returnId: ret.id,
        number: ret.number,
        deliveryId: ret.delivery_id,
        warehouseId: ret.warehouse_id,
        date: await today(ctx),
        reason: input.reason,
        lines: lines.map((l) => ({ lineId: l.id, lineNo: l.line_no, deliveryLineId: l.delivery_line_id, productId: l.product_id, qty: num(l.qty) })),
      });
    }
    return outputOf(ctx, ret.id);
  },
});

/**
 * Refuses (negative_stock_refused) the Anular of a received devolución whose units already left the bucket they entered: per line, what
 * that bucket holds now less what shipped entregas of the product not yet issued may take (conservative). Nothing to check while
 * inventory has not posted the devolución yet (its void then follows the receipt) or in a bodega that allows backorders.
 */
async function assertStockBack(ctx: ProcessContext, ret: ReturnRow): Promise<void> {
  const lines = await ctx.tx<ReturnLineRow[]>`select ${lineColumns(ctx.tx)} from sales.return_lines where return_id = ${ret.id} order by line_no`;
  await lockShipStock(ctx, ret.warehouse_id, lines.map((l) => l.product_id));
  const buckets = await ctx.tx<{ source_line_id: string; product_id: string; qty: string; on_hand: string; allow_backorders: boolean }[]>`
    select source_line_id, product_id, qty::text, on_hand::text, allow_backorders from inventory.source_line_stock('sales.return', ${lines.map((l) => l.id)}::uuid[])`;
  if (buckets.length === 0 || buckets[0]!.allow_backorders) return;
  const pending = await pendingShipped(ctx, ret.warehouse_id, lines.map((l) => l.product_id), null);
  const skus = new Map((await ctx.tx<{ id: string; sku: string }[]>`select id, sku from core.v_product_stock where id = any(${lines.map((l) => l.product_id)}::uuid[])`).map((r) => [r.id, r.sku]));
  const refusals: string[] = [];
  for (const l of lines) {
    // Each bucket the line entered (Task 28.3: a line of a lot product may have re-entered several lots), against what it holds now.
    for (const bucket of buckets.filter((b) => b.source_line_id === l.id)) {
      const pendingQty = pending.filter((p) => p.productId === l.product_id).reduce((sum, p) => sum + p.qty, 0);
      const available = round4(num(bucket.on_hand) - pendingQty);
      if (num(bucket.qty) > available) {
        refusals.push(`Línea ${l.line_no}: el producto ${skus.get(l.product_id) ?? l.product_id} tiene ${qtyText(Math.max(available, 0))} disponibles donde entró la devolución y anularla saca ${qtyText(num(bucket.qty))}: la bodega no permite existencias negativas`);
      }
    }
  }
  if (refusals.length > 0) refuse("negative_stock_refused", refusals);
}

export const returnRestore = defineProcess({
  id: "sales.return.restore",
  module: "sales",
  kind: "update",
  // The devolución named by inventory's refusal: no record of the caller's is changed.
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  description:
    "Devuelve a grabada (recibida) una devolución anulada cuyas existencias el inventario no pudo sacar de nuevo, con el motivo; solo lo ejecuta el evento del inventario",
  input: z.object({ returnId: id, voidedEventId: id.optional(), code: z.string().trim().min(1).max(100), reason: z.string().max(1800) }).strict(),
  output: z.object({ restored: z.boolean() }),
  handler: async (ctx, input) => {
    const { ret } = await lockReturn(ctx, input.returnId);
    if (ret.status !== "voided" || ret.stage !== "received") return { restored: false };
    if (input.voidedEventId) {
      const [last] = await ctx.tx<{ id: string }[]>`
        select id from kernel.outbox where company_id = ${ctx.companyId} and event = ${RETURN_VOIDED} and payload->>'returnId' = ${ret.id}
        order by created_at desc, id desc limit 1`;
      if (last && last.id !== input.voidedEventId) return { restored: false };
    }
    await ctx.tx`
      update sales.returns set status = 'saved', void_reason = null, stock_refusal = ${`${input.code}: ${input.reason}`.slice(0, 2000)}, stock_refused_at = now()
      where id = ${ret.id}`;
    await writeSnapshot(ctx, ctx.registry.entity(returnEntity.id), ret.id, "saved", null);
    return { restored: true };
  },
});

const restorePayload = z.looseObject({ returnId: id, voidedEventId: id.optional(), code: z.string().min(1), reason: z.string() });

/** Consumer of inventory.sale_return_void.refused: the devolución is Grabada (received) again, with inventory's reason. */
export const onReturnVoidRefused: EventConsumer = async (ctx, payload) => {
  const parsed = restorePayload.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `${SALE_RETURN_VOID_REFUSED} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const r = parsed.data;
  await ctx.runProcess("sales.return.restore", { returnId: r.returnId, ...(r.voidedEventId ? { voidedEventId: r.voidedEventId } : {}), code: r.code.slice(0, 100), reason: r.reason.slice(0, 1800) });
};

export const returnConsult = defineProcess({
  id: "sales.return.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una devolución de ventas con sus líneas y los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: returnId }) => {
    const [row] = await ctx.tx`select * from sales.v_returns where id = ${returnId}`;
    if (!row) throw new ProcessError("not_found", `return ${returnId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from sales.v_return_lines where return_id = ${returnId} order by line_no`;
    return { ...row, id: returnId, lines };
  },
});

export const returnLineConsult = defineProcess({
  id: "sales.return_line.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de devolución de ventas con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from sales.v_return_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `return line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/** Grabar changes only the notes and extra data of an open devolución; the number is drawn on save (prefix DEV-). */
export const returnHooks: TypedHooks = {
  async validate(_ctx, _record, mode, { previous, data }) {
    if (mode !== "save" || !data) return;
    const refused = Object.keys(data).filter((name) => !WRITABLE.includes(name));
    if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for sales.return.save", { details: refused.map((name) => `El campo ${name} no se puede modificar con Grabar`) });
    if (previous.stage !== "open" && Object.values(data).some((v) => v !== undefined)) refuseState("return_received", ["Una devolución recibida no cambia"]);
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select sales.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

export const RETURN_PROCESSES = [returnCreate, returnReceive, returnVoid, returnRestore, returnConsult, returnLineConsult];
