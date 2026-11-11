import { defineProcess, ProcessError, runLifecycle, writeSnapshot, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { ALLOCATION_STATUSES, pickEntity, type PickStage } from "../entities";
import { buckets, companyToday, enabledSince, FIRM_ORDER_STAGES, id, num, orderLines, qtyText, quantity, refuse, refuseState, round4, settingsOf, trackingOf, type Tracking } from "./common";

// Alistamientos (plan 2B.2 Task 29.1, PG §4.1–§4.3 steps 1–3 and 7; items 151, 153, 164; RG-7, RG-10). An alistamiento (pick list) is a
// documento numbered ALI- on save that never posts: what to take from which shelf for a confirmed pedido. warehouse.pick.create makes it
// from sales.order.confirmed (when auto_pick_on_confirm is on) or from the pedido («Crear alistamiento»), one open alistamiento per pedido;
// it proposes per pedido line the ubicación and lot from inventory's stock (inventory.v_stock_levels, v_lots, v_locations, published) by
// FEFO, then by the ubicación with most free stock, splitting a line over buckets when one does not hold it all; what no bucket holds stays
// a line without ubicación. Bins are inventory locations (item 151). warehouse.pick.start hands it to a picker («En proceso»);
// warehouse.pick.update and warehouse.pick.confirm take what the picker took (ubicación, lot, serial, quantity; a line may be split), and
// the confirmation emits warehouse.pick.confirmed { pickId, orderId, warehouseId, createDelivery, lines } for inventory to allocate the
// pedido lines' reservations (inventory.reservation.allocate). The pick never moves stock (RG-7): stock moves at the entrega's ship.
// Inventory answers with inventory.reservation.allocated; warehouse.pick.record_allocation records it, and a short answer sends the
// alistamiento back to «En proceso» naming the short lines. A cancelled pedido voids its alistamientos (consumers.ts); inventory's release
// drops the allocations with the reservation.
//
// RG-10 (item 164): a company that never bought the module parks sales.order.confirmed `not_entitled:warehouse`; once bought the event is
// replayed, and the create answers { created: false, reason: "before_enabled" } for a pedido confirmed before the module started for the
// company (enabledSince), or "fully_delivered" when nothing is left to deliver; so buying the module never makes alistamientos for old
// pedidos. Warehouse never imports sales or inventory (rule 4): it reads their published views and talks by event (rule 3).

const FEATURE = "warehouse.picking";
export const PICK_CONFIRMED = "warehouse.pick.confirmed";
const NUMBER_PREFIX = "ALI-";
/** What Grabar may change of an alistamiento (its lines change through update and confirm). */
const WRITABLE = ["notes", "extra", "extra_free"];

interface PickRow {
  id: string; number: string | null; status: string; stage: PickStage; order_id: string; order_number: string | null; warehouse_id: string; party_id: string;
}
interface PickLineRow {
  id: string; line_no: number; order_line_id: string; product_id: string; qty_requested: string; location_id: string | null; lot_id: string | null; serial_id: string | null;
  qty_picked: string | null; short_qty: string | null;
}

const lineOutput = z.object({
  id: z.string(), lineNo: z.number(), orderLineId: z.string(), productId: z.string(), qtyRequested: z.number(),
  locationId: z.string().nullable(), lotId: z.string().nullable(), serialId: z.string().nullable(), qtyPicked: z.number().nullable(), shortQty: z.number().nullable(),
});
const pickOutput = z.object({
  id: z.string(), number: z.string().nullable(), status: z.string(), stage: z.string(), orderId: z.string(), orderNumber: z.string().nullable(), warehouseId: z.string(),
  lines: z.array(lineOutput),
});
type PickOutput = z.output<typeof pickOutput>;

const label = (p: Pick<PickRow, "number" | "id">) => p.number ?? p.id;

async function outputOf(ctx: ProcessContext, pickId: string): Promise<PickOutput> {
  const [row] = await ctx.tx<PickRow[]>`select id, number, status, stage, order_id, order_number, warehouse_id, party_id from warehouse.picks where id = ${pickId}`;
  if (!row) throw new ProcessError("not_found", `pick ${pickId} not found`);
  const lines = await linesOf(ctx, pickId);
  return {
    id: row.id, number: row.number, status: row.status, stage: row.stage, orderId: row.order_id, orderNumber: row.order_number, warehouseId: row.warehouse_id,
    lines: lines.map((l) => ({
      id: l.id, lineNo: l.line_no, orderLineId: l.order_line_id, productId: l.product_id, qtyRequested: num(l.qty_requested), locationId: l.location_id, lotId: l.lot_id,
      serialId: l.serial_id, qtyPicked: l.qty_picked === null ? null : num(l.qty_picked), shortQty: l.short_qty === null ? null : num(l.short_qty),
    })),
  };
}

const linesOf = (ctx: ProcessContext, pickId: string) =>
  ctx.tx<PickLineRow[]>`
    select id, line_no, order_line_id, product_id, qty_requested::text, location_id, lot_id, serial_id, qty_picked::text, short_qty::text
    from warehouse.pick_lines where pick_id = ${pickId} order by line_no`;

/** The alistamiento locked for the step, or `not_found`. */
async function lockPick(ctx: ProcessContext, pickId: string): Promise<PickRow> {
  const [row] = await ctx.tx<PickRow[]>`
    select id, number, status, stage, order_id, order_number, warehouse_id, party_id from warehouse.picks where id = ${pickId} for update`;
  if (!row) throw new ProcessError("not_found", `pick ${pickId} not found`);
  return row;
}

/** Refuses a step on an alistamiento that is voided or already confirmed. */
function assertOpen(pick: PickRow): void {
  if (pick.status === "voided") refuseState("pick_voided", [`El alistamiento ${label(pick)} está anulado`]);
  if (pick.stage === "confirmed") refuseState("pick_confirmed", [`El alistamiento ${label(pick)} ya está confirmado: no cambia`]);
}

/** Keeps the version of an alistamiento whose stage changed (entity types spec §8: every change past Borrador). */
async function snapshot(ctx: ProcessContext, pickId: string, status: string): Promise<void> {
  await writeSnapshot(ctx, ctx.registry.entity(pickEntity.id), pickId, status as never, null);
}

// -------------------------------------------------------------------------------------------------
// Crear
// -------------------------------------------------------------------------------------------------

const createOutput = z.object({
  created: z.boolean(),
  /** Why nothing was created: RG-10's before_enabled / fully_delivered, an open alistamiento of the pedido, the setting off (event path). */
  reason: z.enum(["before_enabled", "fully_delivered", "open_pick", "auto_pick_off", "order_cancelled", "no_warehouse"]).optional(),
  pick: pickOutput.optional(),
});
type CreateOutput = z.output<typeof createOutput>;

/** What the proposal takes from each bucket (several pedido lines of one product share the buckets). */
interface Proposed { orderLineId: string; productId: string; qty: number; locationId: string | null; lotId: string | null }

/**
 * The proposal of an alistamiento: per pedido line with something left to deliver, the buckets of its product in FEFO order then most free
 * stock (common.ts buckets), each taken up to what is left of it; what no bucket covers is one more line without ubicación. A product that
 * keeps no stock (a service) is not picked.
 */
async function propose(ctx: ProcessContext, warehouseId: string, lines: { id: string; product_id: string; left: number }[]): Promise<Proposed[]> {
  const products = [...new Set(lines.map((l) => l.product_id))];
  const facts = new Map((await ctx.tx<{ id: string; kind: string; track_stock: boolean }[]>`
    select id, kind, track_stock from core.v_product_stock where id = any(${products}::uuid[])`).map((p) => [p.id, p]));
  const stocked = lines.filter((l) => {
    const p = facts.get(l.product_id);
    return p && p.kind !== "service" && p.track_stock;
  });
  const stock = await buckets(ctx, warehouseId, [...new Set(stocked.map((l) => l.product_id))], await companyToday(ctx));
  const free = stock.map((b) => ({ ...b }));
  const out: Proposed[] = [];
  for (const line of stocked) {
    let need = line.left;
    for (const b of free) {
      if (need <= 0) break;
      if (b.productId !== line.product_id || b.free <= 0) continue;
      const take = round4(Math.min(need, b.free));
      b.free = round4(b.free - take);
      need = round4(need - take);
      out.push({ orderLineId: line.id, productId: line.product_id, qty: take, locationId: b.locationId, lotId: b.lotId });
    }
    if (need > 0) out.push({ orderLineId: line.id, productId: line.product_id, qty: need, locationId: null, lotId: null });
  }
  return out;
}

export const pickCreate = defineProcess({
  id: "warehouse.pick.create",
  module: "warehouse",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE,
  emits: [],
  description:
    "Crea el alistamiento de un pedido confirmado: propone por cada línea la ubicación y el lote (primero el que vence antes, luego la ubicación con más existencias) de lo que falta por entregar; si el pedido ya tiene un alistamiento abierto, lo devuelve. No mueve inventario",
  input: z.object({
    orderId: id,
    /** Only the consumer of sales.order.confirmed (origin event): the event's id (a redelivery answers the first run) and when the pedido was confirmed. */
    eventId: id.optional(),
    confirmedAt: z.string().optional(),
  }).strict(),
  output: createOutput,
  auditInput: (input) => ({ orderId: input.orderId }),
  idempotencyKey: (input) => (input.eventId ? `pick_create:${input.eventId}` : undefined),
  handler: async (ctx, input): Promise<CreateOutput> => {
    const fromEvent = ctx.origin === "event" && input.eventId !== undefined;
    if (fromEvent && !(await settingsOf(ctx)).autoPickOnConfirm) return { created: false, reason: "auto_pick_off" };
    // One run at a time per pedido (the event and «Crear alistamiento» may race): the second sees the first's alistamiento.
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`warehouse.pick:${ctx.companyId}:${input.orderId}`}, 0))`;
    const lines = await orderLines(ctx, input.orderId);
    if (lines.length === 0) throw new ProcessError("not_found", `order ${input.orderId} not found`);
    const order = lines[0]!;
    const orderLabel = order.order_number ?? order.order_id;
    if (order.order_stage === "cancelled" || order.order_status === "voided") {
      if (fromEvent) return { created: false, reason: "order_cancelled" };
      refuseState("order_cancelled", [`El pedido ${orderLabel} está cancelado`]);
    }
    if (order.order_stage === "delivered") return { created: false, reason: "fully_delivered" };
    if (!FIRM_ORDER_STAGES.has(order.order_stage)) refuseState("order_not_confirmed", [`El pedido ${orderLabel} no está confirmado: se alista una vez confirmado`]);
    // RG-10: a confirmation the module did not see live (parked before the company bought it, replayed now) makes no alistamiento.
    if (fromEvent) {
      const since = await enabledSince(ctx);
      const confirmedAt = input.confirmedAt ? new Date(input.confirmedAt) : order.confirmed_at;
      if (since && confirmedAt && confirmedAt.getTime() < since.getTime()) return { created: false, reason: "before_enabled" };
    }
    const left = lines.map((l) => ({ id: l.id, product_id: l.product_id, left: round4(num(l.qty) - num(l.committed_qty)) })).filter((l) => l.left > 0);
    if (left.length === 0) return { created: false, reason: "fully_delivered" };
    const [open] = await ctx.tx<{ id: string }[]>`
      select id from warehouse.picks where company_id = ${ctx.companyId} and order_id = ${input.orderId} and stage <> 'confirmed' and status <> 'voided' limit 1`;
    if (open) return { created: false, reason: "open_pick", pick: await outputOf(ctx, open.id) };
    if (!order.warehouse_id) {
      if (fromEvent) return { created: false, reason: "no_warehouse" };
      refuse("warehouse_required", [`El pedido ${orderLabel} no tiene bodega: indícala en el pedido antes de alistarlo`]);
    }
    const proposal = await propose(ctx, order.warehouse_id, left);
    if (proposal.length === 0) return { created: false, reason: "fully_delivered" };

    const [header] = await ctx.tx<{ id: string }[]>`
      insert into warehouse.picks ${ctx.tx({
        company_id: ctx.companyId,
        order_id: order.order_id,
        order_number: order.order_number,
        warehouse_id: order.warehouse_id,
        party_id: order.party_id,
        stage: "open",
        // An alistamiento neither waits for approval nor posts (ownFlags).
        requires_approval: false,
        posts: false,
      })}
      returning id`;
    await ctx.tx`insert into warehouse.pick_lines ${ctx.tx(proposal.map((p, i) => ({
      company_id: ctx.companyId, pick_id: header!.id, line_no: i + 1, order_line_id: p.orderLineId, product_id: p.productId, qty_requested: p.qty,
      location_id: p.locationId, lot_id: p.lotId,
    })))}`;
    await runLifecycle(ctx, ctx.registry.entity(pickEntity.id), header!.id, "save");
    return { created: true, pick: await outputOf(ctx, header!.id) };
  },
});

// -------------------------------------------------------------------------------------------------
// Lo que el alistador tomó: update, start, confirm
// -------------------------------------------------------------------------------------------------

/**
 * What the picker took of a line: the ubicación, the lot (a lot product), the serial (a serial product, one per unit) and the quantity. The
 * same pick line may come more than once (a split over two lots or the serials of the line): the first entry rewrites the line, the next ones
 * add lines for the same pedido line.
 */
const pickedInput = z.object({
  pickLineId: id,
  locationId: id.nullable().optional(),
  lotId: id.nullable().optional(),
  serialId: id.nullable().optional(),
  qtyPicked: quantity,
}).strict();
type PickedInput = z.output<typeof pickedInput>;

interface FinalLine { id?: string; order_line_id: string; product_id: string; qty_requested: number; location_id: string | null; lot_id: string | null; serial_id: string | null; qty_picked: number | null }

/** The lines as they will be once `entries` apply (nothing written yet). */
function applyEntries(lines: PickLineRow[], entries: PickedInput[]): FinalLine[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const unknown = entries.filter((e) => !byId.has(e.pickLineId));
  if (unknown.length > 0) refuse("invalid_pick_line", unknown.map((e) => `La línea ${e.pickLineId} no es de este alistamiento`));
  const out: FinalLine[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const mine = entries.filter((e) => e.pickLineId === line.id);
    const base: FinalLine = {
      id: line.id, order_line_id: line.order_line_id, product_id: line.product_id, qty_requested: num(line.qty_requested), location_id: line.location_id,
      lot_id: line.lot_id, serial_id: line.serial_id, qty_picked: line.qty_picked === null ? null : num(line.qty_picked),
    };
    if (mine.length === 0) {
      out.push(base);
      continue;
    }
    mine.forEach((e, i) => {
      const next = i === 0 ? base : { ...base, id: undefined, qty_requested: 0 };
      out.push({
        ...next,
        location_id: e.locationId === undefined ? next.location_id : e.locationId,
        lot_id: e.lotId === undefined ? next.lot_id : e.lotId,
        serial_id: e.serialId === undefined ? next.serial_id : e.serialId,
        qty_picked: e.qtyPicked,
      });
    });
    seen.add(line.id);
  }
  return out;
}

/**
 * Refuses what the picker cannot have taken (read in inventory's published views, rule 3): more of a pedido line than the alistamiento asks
 * (pick_over_requested); a ubicación outside the bodega or in transit (invalid_location); a lot or serial of another product
 * (lot_not_found, serial_not_found); and, when `final`, a line taken without ubicación (location_required), a lot product without lot
 * (lot_required), a serial product without one serial per unit (serials_required) or an untracked product naming a lot or serial
 * (product_not_tracked). Line numbers in the reasons are the alistamiento's.
 */
async function assertPicked(ctx: ProcessContext, pick: PickRow, lines: FinalLine[], final: boolean): Promise<void> {
  const picked = (l: FinalLine) => l.qty_picked ?? (final && l.location_id ? l.qty_requested : 0);
  const requested = new Map<string, number>();
  const taken = new Map<string, number>();
  for (const l of lines) {
    requested.set(l.order_line_id, round4((requested.get(l.order_line_id) ?? 0) + l.qty_requested));
    taken.set(l.order_line_id, round4((taken.get(l.order_line_id) ?? 0) + picked(l)));
  }
  const over = [...taken].filter(([orderLine, qty]) => qty > (requested.get(orderLine) ?? 0));
  if (over.length > 0) {
    refuse("pick_over_requested", over.map(([orderLine, qty]) => {
      const no = lines.findIndex((l) => l.order_line_id === orderLine) + 1;
      return `Línea ${no}: el alistamiento pide ${qtyText(requested.get(orderLine) ?? 0)} y se tomaron ${qtyText(qty)}`;
    }));
  }
  const locationIds = [...new Set(lines.flatMap((l) => (l.location_id ? [l.location_id] : [])))];
  const lotIds = [...new Set(lines.flatMap((l) => (l.lot_id ? [l.lot_id] : [])))];
  const serialIds = [...new Set(lines.flatMap((l) => (l.serial_id ? [l.serial_id] : [])))];
  const locations = new Map((locationIds.length === 0 ? [] : await ctx.tx<{ id: string; warehouse_id: string; kind: string }[]>`
    select id, warehouse_id, kind from inventory.v_locations where id = any(${locationIds}::uuid[])`).map((r) => [r.id, r]));
  const lots = new Map((lotIds.length === 0 ? [] : await ctx.tx<{ id: string; product_id: string }[]>`
    select id, product_id from inventory.v_lots where id = any(${lotIds}::uuid[])`).map((r) => [r.id, r.product_id]));
  const serials = new Map((serialIds.length === 0 ? [] : await ctx.tx<{ id: string; product_id: string; lot_id: string | null }[]>`
    select id, product_id, lot_id from inventory.v_serials where id = any(${serialIds}::uuid[])`).map((r) => [r.id, r]));
  const tracking = await trackingOf(ctx, [...new Set(lines.map((l) => l.product_id))]);
  const problems: Record<string, string[]> = {};
  const add = (code: string, text: string) => (problems[code] ??= []).push(text);
  lines.forEach((l, i) => {
    const no = `Línea ${i + 1}`;
    const loc = l.location_id ? locations.get(l.location_id) : undefined;
    if (l.location_id && (!loc || loc.warehouse_id !== pick.warehouse_id || loc.kind !== "storage")) add("invalid_location", `${no}: la ubicación no es de la bodega del alistamiento o es de tránsito`);
    if (l.lot_id && lots.get(l.lot_id) !== l.product_id) add("lot_not_found", `${no}: el lote no existe o es de otro producto`);
    if (l.serial_id && serials.get(l.serial_id)?.product_id !== l.product_id) add("serial_not_found", `${no}: el serial no existe o es de otro producto`);
    if (l.serial_id && picked(l) > 1) add("serials_required", `${no}: un serial es una unidad; indica un serial por unidad`);
    if (!final || picked(l) <= 0) return;
    const t: Tracking = tracking.get(l.product_id)?.tracking ?? "none";
    if (!l.location_id) add("location_required", `${no}: indica de qué ubicación se tomó`);
    if (t === "lot" && !l.lot_id) add("lot_required", `${no}: el producto se controla por lote; indica el lote tomado`);
    if (t === "serial" && !l.serial_id) add("serials_required", `${no}: el producto se controla por serial; indica un serial por unidad`);
    if (t === "none" && (l.lot_id || l.serial_id)) add("product_not_tracked", `${no}: el producto no se controla por lote ni serial`);
  });
  const [code] = Object.keys(problems);
  if (code) refuse(code, problems[code]!);
}

/** Writes the lines as `final` says: existing ones updated, split ones added (numbered after the last line). */
async function writeLines(ctx: ProcessContext, pickId: string, lines: FinalLine[]): Promise<void> {
  let next = Math.max(0, ...(await ctx.tx<{ line_no: number }[]>`select line_no from warehouse.pick_lines where pick_id = ${pickId}`).map((r) => r.line_no));
  for (const l of lines) {
    const set = { location_id: l.location_id, lot_id: l.lot_id, serial_id: l.serial_id, qty_picked: l.qty_picked, short_qty: null };
    if (l.id) await ctx.tx`update warehouse.pick_lines set ${ctx.tx(set)} where id = ${l.id}`;
    else {
      next += 1;
      await ctx.tx`insert into warehouse.pick_lines ${ctx.tx({ company_id: ctx.companyId, pick_id: pickId, line_no: next, order_line_id: l.order_line_id, product_id: l.product_id, qty_requested: l.qty_requested, ...set })}`;
    }
  }
}

export const pickUpdate = defineProcess({
  id: "warehouse.pick.update",
  module: "warehouse",
  kind: "update",
  feature: FEATURE,
  description: "Anota en un alistamiento abierto o en proceso lo que se va tomando (ubicación, lote, serial y cantidad por línea) y sus notas, sin confirmarlo",
  input: z.object({
    id,
    notes: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(pickedInput).min(1).max(500).optional(),
  }).strict(),
  output: pickOutput,
  handler: async (ctx, input) => {
    const pick = await lockPick(ctx, input.id);
    assertOpen(pick);
    if (input.lines) {
      const final = applyEntries(await linesOf(ctx, pick.id), input.lines);
      await assertPicked(ctx, pick, final, false);
      await writeLines(ctx, pick.id, final);
    }
    if (input.notes !== undefined) await ctx.tx`update warehouse.picks set notes = ${input.notes} where id = ${pick.id}`;
    return outputOf(ctx, pick.id);
  },
});

export const pickStart = defineProcess({
  id: "warehouse.pick.start",
  module: "warehouse",
  kind: "update",
  feature: FEATURE,
  description: "Empieza un alistamiento: queda «En proceso» a cargo del alistador (quien lo ejecuta, o el usuario indicado)",
  input: z.object({ id, pickerUserId: id.optional() }).strict(),
  output: pickOutput,
  handler: async (ctx, input) => {
    const pick = await lockPick(ctx, input.id);
    assertOpen(pick);
    await ctx.tx`
      update warehouse.picks set stage = 'in_progress', picker_user_id = ${input.pickerUserId ?? ctx.userId}, started_at = coalesce(started_at, now())
      where id = ${pick.id}`;
    if (pick.stage !== "in_progress") await snapshot(ctx, pick.id, pick.status);
    return outputOf(ctx, pick.id);
  },
});

const confirmedLine = z.object({
  orderLineId: z.string(), productId: z.string(), locationId: z.string(), lotId: z.string().nullable(), serialId: z.string().nullable(), qty: z.number(),
});

export const pickConfirm = defineProcess({
  id: "warehouse.pick.confirm",
  module: "warehouse",
  kind: "update",
  feature: FEATURE,
  emits: [PICK_CONFIRMED],
  description:
    "Confirma lo que se tomó en un alistamiento (las líneas indicadas, o lo propuesto): el inventario asigna la ubicación, el lote y el serial a la reserva del pedido; no mueve existencias. Si una línea no alcanza, el alistamiento vuelve a «En proceso»",
  input: z.object({ id, lines: z.array(pickedInput).min(1).max(500).optional() }).strict(),
  output: pickOutput,
  handler: async (ctx, input) => {
    const pick = await lockPick(ctx, input.id);
    assertOpen(pick);
    const lines = await orderLines(ctx, pick.order_id);
    const stage = lines[0]?.order_stage;
    if (!stage || stage === "cancelled" || lines[0]!.order_status === "voided") refuseState("order_cancelled", [`El pedido ${pick.order_number ?? pick.order_id} está cancelado`]);
    const final = applyEntries(await linesOf(ctx, pick.id), input.lines ?? []);
    // A line nobody touched is taken as proposed (from its ubicación), or not at all (no ubicación: what no bucket held).
    for (const l of final) if (l.qty_picked === null) l.qty_picked = l.location_id ? l.qty_requested : 0;
    await assertPicked(ctx, pick, final, true);
    const taken = final.filter((l) => (l.qty_picked ?? 0) > 0);
    if (taken.length === 0) refuse("nothing_picked", [`El alistamiento ${label(pick)} no tiene nada tomado`]);
    await writeLines(ctx, pick.id, final);
    await ctx.tx`
      update warehouse.picks set stage = 'confirmed', confirmed_at = now(), allocation_status = null, allocated_at = null, allocation_note = null,
             started_at = coalesce(started_at, now()), picker_user_id = coalesce(picker_user_id, ${ctx.userId})
      where id = ${pick.id}`;
    await snapshot(ctx, pick.id, pick.status);
    const { deliveryFromPick } = await settingsOf(ctx);
    await ctx.emit(PICK_CONFIRMED, {
      pickId: pick.id,
      number: pick.number,
      orderId: pick.order_id,
      warehouseId: pick.warehouse_id,
      createDelivery: deliveryFromPick,
      lines: taken.map((l) => confirmedLine.parse({
        orderLineId: l.order_line_id, productId: l.product_id, locationId: l.location_id, lotId: l.lot_id, serialId: l.serial_id, qty: l.qty_picked,
      })),
    });
    return outputOf(ctx, pick.id);
  },
});

// -------------------------------------------------------------------------------------------------
// Anular, consultar
// -------------------------------------------------------------------------------------------------

export const pickVoid = defineProcess({
  id: "warehouse.pick.void",
  module: "warehouse",
  kind: "update",
  feature: FEATURE,
  description: "Anula un alistamiento que no se ha confirmado, con el motivo (al cancelar su pedido, se anula aunque estuviera confirmado)",
  input: z.object({ id, reason: z.string().trim().min(1, "Indica el motivo").max(1000), expectedUpdatedAt: z.string().optional() }).strict(),
  output: pickOutput,
  handler: async (ctx, input) => {
    const pick = await lockPick(ctx, input.id);
    if (pick.status === "voided") refuseState("pick_voided", [`El alistamiento ${label(pick)} ya está anulado`]);
    // A confirmed alistamiento has its allocation in inventory: only its pedido's cancellation (origin event) voids it, and inventory's
    // release of the reservation drops the allocation with it.
    if (pick.stage === "confirmed" && ctx.origin !== "event") refuseState("pick_confirmed", [`El alistamiento ${label(pick)} ya está confirmado: no se anula`]);
    await runLifecycle(ctx, ctx.registry.entity(pickEntity.id), pick.id, "void", { reason: input.reason, ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}) });
    return outputOf(ctx, pick.id);
  },
});

export const pickConsult = defineProcess({
  id: "warehouse.pick.consult",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un alistamiento con sus líneas y los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: pickId }) => {
    const [row] = await ctx.tx<Record<string, unknown>[]>`select * from warehouse.v_picks where id = ${pickId}`;
    if (!row) throw new ProcessError("not_found", `pick ${pickId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from warehouse.v_pick_lines where pick_id = ${pickId} order by line_no`;
    return { ...row, id: pickId, lines };
  },
});

export const pickLineConsult = defineProcess({
  id: "warehouse.pick_line.consult",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de alistamiento con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx<Record<string, unknown>[]>`select * from warehouse.v_pick_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `pick line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

// -------------------------------------------------------------------------------------------------
// La respuesta del inventario
// -------------------------------------------------------------------------------------------------

const shortLine = z.looseObject({ orderLineId: id, productId: id, qty: z.number(), available: z.number(), locationId: id.nullable().optional(), lotId: id.nullable().optional(), serialId: id.nullable().optional() });

export const pickRecordAllocation = defineProcess({
  id: "warehouse.pick.record_allocation",
  module: "warehouse",
  kind: "update",
  // The alistamiento named by inventory's answer: no record of the caller's is changed.
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  description:
    "Registra en un alistamiento confirmado la respuesta del inventario: asignado, o faltante (vuelve a «En proceso» con las líneas que no alcanzaron); solo lo ejecuta el evento del inventario",
  idempotencyKey: (input) => `record_allocation:${input.eventId}`,
  input: z.object({ pickId: id, eventId: id, status: z.enum(ALLOCATION_STATUSES), short: z.array(shortLine).max(5000) }).strict(),
  output: z.object({ recorded: z.boolean(), stage: z.string().optional() }),
  handler: async (ctx, input) => {
    const [pick] = await ctx.tx<PickRow[]>`
      select id, number, status, stage, order_id, order_number, warehouse_id, party_id from warehouse.picks where id = ${input.pickId} for update`;
    // A voided alistamiento, or one confirmed again since (a later answer will come), keeps what it has.
    if (!pick || pick.status === "voided" || pick.stage !== "confirmed") return { recorded: false };
    if (input.status === "allocated") {
      await ctx.tx`update warehouse.picks set allocation_status = 'allocated', allocated_at = now(), allocation_note = null where id = ${pick.id}`;
      return { recorded: true, stage: "confirmed" };
    }
    const lines = await linesOf(ctx, pick.id);
    const facts = new Map((await ctx.tx<{ id: string; sku: string }[]>`
      select id, sku from core.v_product_stock where id = any(${[...new Set(input.short.map((s) => s.productId))]}::uuid[])`).map((p) => [p.id, p.sku]));
    const matches = (l: PickLineRow, s: z.output<typeof shortLine>) =>
      l.order_line_id === s.orderLineId && (s.locationId === undefined || l.location_id === s.locationId) && (s.lotId === undefined || l.lot_id === (s.lotId ?? null))
      && (s.serialId === undefined || l.serial_id === (s.serialId ?? null)) && num(l.qty_picked) > 0;
    const notes: string[] = [];
    const shortOf = new Map<string, number>();
    for (const s of input.short) {
      const line = lines.find((l) => matches(l, s) && !shortOf.has(l.id)) ?? lines.find((l) => l.order_line_id === s.orderLineId);
      const missing = round4(s.qty - Math.max(s.available, 0));
      if (line && missing > 0) shortOf.set(line.id, missing);
      notes.push(`Línea ${line?.line_no ?? "?"} (${facts.get(s.productId) ?? s.productId}): se tomaron ${qtyText(s.qty)} y hay ${qtyText(Math.max(s.available, 0))} disponibles`);
    }
    // The stage first: the lines of a confirmed alistamiento do not change (0170's trigger).
    await ctx.tx`
      update warehouse.picks set stage = 'in_progress', allocation_status = 'short', allocated_at = now(), allocation_note = ${notes.join("; ").slice(0, 4000)}
      where id = ${pick.id}`;
    for (const [lineId, missing] of shortOf) await ctx.tx`update warehouse.pick_lines set short_qty = ${missing} where id = ${lineId}`;
    await snapshot(ctx, pick.id, pick.status);
    return { recorded: true, stage: "in_progress" };
  },
});

/**
 * The hooks of an alistamiento: Grabar changes only its notes and extra data (its lines change through update and confirm); the number is
 * drawn on save from the company counter (prefix ALI-).
 */
export const pickHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    if (mode !== "save" || !data) return;
    const refused = Object.keys(data).filter((name) => !WRITABLE.includes(name));
    if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for warehouse.pick.save", { details: refused.map((name) => `El campo ${name} no se puede modificar con Grabar`) });
    if (record.status === "voided") refuseState("pick_voided", ["Un alistamiento anulado no cambia"]);
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select warehouse.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

export const PICK_PROCESSES = [pickCreate, pickUpdate, pickStart, pickConfirm, pickVoid, pickConsult, pickLineConsult, pickRecordAllocation];
