import { defineProcess, ProcessError, runLifecycle, visibleExtra, type EventConsumer, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { KIND_PREFIX, KIND_SIGN, movementEntity, POSTABLE_KINDS, type MovementKind } from "../entities";
import { entityId, id, idInput, num, productCosts, productFacts, qtyText, quantity, refuse, type ProductFacts } from "./common";
import { lockTracking, moveSerials, resolveTracked, serialLockKey, serialsAfterVoid, trackingKinds } from "./tracked-lines";

// Inventory movements (plan 2B Task 6, design §8.1, Review Focus 1). inventory.movement.post registers a movement and moves the stock in
// one transaction: the header and its lines, the stock levels of every product and ubicación it touches (locked through lockStock, the
// one lock order every stock writer and reservation follows, so they queue instead of deadlocking), the number (on save, D9) and the event
// `inventory.movement.posted`. Stock below zero is refused (`negative_stock_refused`) unless the bodega allows backorders (OD-3); a service
// is refused (`service_product_refused`); a product that does not keep stock (track_stock = false) moves nothing and is skipped. A movement
// that answers to a source (a delivery line, a return line) is posted once per source line: a redelivered event finds its movement and
// answers it (the idempotency key is the source line id, kept unique in the database too). Anular reverses the stock under the same rule.
// Callable by the UI, the assistant and the event consumers (origin `event`, as the system user). Postings to the ledger come from the
// events (costing values the issues, Task 8; accounting posts adjustments, Task 7): a movement never posts itself (contabiliza false).

const FEATURE = "inventory.stock";

export const MOVEMENT_POSTED = "inventory.movement.posted";
export const MOVEMENT_VOIDED = "inventory.movement.voided";

const date = z.iso.date();

export const movementLineInput = z.object({
  productId: id,
  /** A ubicación of the movement's bodega; none moves the bodega's own stock. */
  locationId: id.optional(),
  /** Signed: + adds stock, − takes it. */
  qty: quantity.refine((n) => n !== 0, "La cantidad no puede ser cero"),
  /** The product's unit (no conversion in 2B): checked against it, defaults to it. */
  uom: z.string().trim().min(1).max(10).optional(),
  /** Company currency, per unit: a receipt may bring its cost for the weighted average (Task 8). */
  unitCost: z.number().finite().min(0).optional(),
  /** The line of the source document this line answers to (the idempotency key). */
  sourceLineId: id.optional(),
  /**
   * A sale return only: the source line of the sale issue it returns (the delivery line, `sales.delivery`): the returned units re-enter at
   * that issue's cost (costing, plan 2B Task 8). Stored as `return_of_line_id`, the sale issue's movement line.
   */
  returnOf: z.object({ sourceEntity: entityId, sourceLineId: id }).strict().optional(),
  /** A lot-tracked product (Task 28.2): the lot the line moves, by id. */
  lotId: id.optional(),
  /** A lot-tracked product: the lot by its code (whatever its case); an inbound line with a new code creates the lot nested. */
  lot: z.object({ code: z.string().trim().min(1).max(60), expiresOn: date.optional(), producedOn: date.optional() }).strict().optional(),
  /** A serial-tracked product: one serial per unit, by id. The line becomes one movement line per serial. */
  serialIds: z.array(id).min(1).max(500).optional(),
  /** A serial-tracked product: one serial per unit, by number; an inbound line with a new number registers the serial nested. */
  serials: z.array(z.object({ serialNo: z.string().trim().min(1).max(80) }).strict()).min(1).max(500).optional(),
}).strict();

export const movementInput = z.object({
  kind: z.enum(POSTABLE_KINDS),
  date,
  warehouseId: id,
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  sourceEntity: entityId.optional(),
  sourceId: id.optional(),
  /** The cost center of the ledger entries the movement's valuation brings (a sale issue's cost of sales): accounting's id, passed on. */
  costCenterId: id.optional(),
  lines: z.array(movementLineInput).min(1).max(500),
}).strict();

/** What a movement process passes to postMovement: any kind (an adjustment or a transfer leg comes from its own process, Task 7). */
export type MovementInput = Omit<z.output<typeof movementInput>, "kind"> & {
  kind: MovementKind;
  /** Only a traslado's own legs move stock in the transit bodega; every other movement into or out of it is refused. */
  allowTransit?: boolean;
  /** Carried in the event (adjustments: on every line, for the ledger rule; other kinds: in the header, for costing's COGS). Accounting's id, passed on. */
  costCenterId?: string;
  /** The customer a sale issue or a sale return answers to (Task 28.4, PG §3.6): core's party id, for the recall report. Only those two kinds. */
  partyId?: string;
};

export const postedOutput = z.object({
  id: z.string().nullable(),
  number: z.string().nullable(),
  /** saved; voided when a redelivery finds the movement the source already undid; skipped when nothing moved. */
  status: z.enum(["saved", "voided", "skipped"]),
  /** Lines of products that keep no stock: not moved. */
  skippedLines: z.number().int(),
});
export type PostedMovement = z.output<typeof postedOutput>;

/** One line of the `inventory.movement.posted` / `.voided` payload. */
export interface MovementEventLine {
  lineId: string;
  lineNo: number;
  productId: string;
  categoryId: string | null;
  warehouseId: string;
  locationId: string | null;
  qty: number;
  uom: string;
  unitCost: number | null;
  sourceLineId: string | null;
  /** A sale return line: the sale issue's movement line it returns (costing re-enters it at that line's cost). */
  returnOfLineId?: string;
  /** Adjustments only: qty × unit cost, signed (+ a gain, − a loss), two decimals; the 2A rule `inventory-adjustment` posts it. */
  value?: number;
  /** Adjustments only, when the request names one: the cost center the adjustment account of the rule may require (accounting's id). */
  costCenterId?: string;
  /** A lot-tracked line (Task 28.2): the lot it moved. Absent on untracked lines. */
  lotId?: string;
  /** A serial-tracked line: the serial it moved (qty ±1). Absent on untracked lines. */
  serialId?: string;
}

/** The payload of `inventory.movement.posted` and `inventory.movement.voided` (the 2A fixture's shape: movementId, kind, lines[], date). */
export interface MovementEvent {
  movementId: string;
  number: string;
  kind: MovementKind;
  date: string;
  warehouseId: string;
  sourceEntity: string | null;
  sourceId: string | null;
  lines: MovementEventLine[];
  /** Adjustments only: the sum of the lines' absolute values (0 when no line has a cost: the rule then posts nothing). */
  value?: number;
  /** Adjustments only: true when some line has no cost (neither its own nor a standard cost): its value is 0 and costing raises cost_missing. */
  costMissing?: boolean;
  /** The cost center the request named (not on adjustments, whose lines carry it): costing passes it on to the COGS of a sale issue. */
  costCenterId?: string;
  /** inventory.movement.voided only: the day of the void in the company's time zone (costing dates its reversal by it, Task 14). */
  voidedOn?: string;
}

interface StockDelta {
  productId: string;
  locationId: string | null;
  /** The bucket's lot and serial (Task 28.2); absent or null for an untracked product. */
  lotId?: string | null;
  serialId?: string | null;
  /** The lot's code or the serial's number, for the refusal. */
  label?: string;
  qty: number;
  sku: string;
}

/** The key of a stock bucket: product, ubicación, lot and serial. */
const bucketKey = (r: { productId: string; locationId: string | null; lotId?: string | null; serialId?: string | null }) =>
  `${r.productId}|${r.locationId ?? ""}|${r.lotId ?? ""}|${r.serialId ?? ""}`;

/** Quantities carry 4 decimals (numeric(18,4)): sums of them are rounded back so a double never drifts into the database. */
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** Money to two decimals, half away from zero (the ledger's rounding, design §10a.8). */
const round2 = (n: number) => (Math.sign(n) * Math.round(Math.abs(n) * 100)) / 100 || 0;

/**
 * Takes the stock locks of `productIds` in `warehouseId`, in the caller's transaction, in the ONE order every caller follows: first a
 * transaction-scoped advisory lock per (company, bodega, product), products in ascending id order; then every existing stock row of those
 * products in the bodega, in one statement ordered by (product, ubicación nulls first), `for update`. The advisory lock is what makes
 * creating a missing row safe without `insert … on conflict` (which would draw a `seq` before the conflict check and leave a gap, rule 7)
 * and what makes a movement and a reservation of the same product queue whatever ubicaciones each touches: both take the product's lock
 * before any row, so no two of them can hold locks the other waits for. Returns the locked rows.
 */
export async function lockStock(ctx: ProcessContext, warehouseId: string, productIds: readonly string[]): Promise<{ id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }[]> {
  const products = [...new Set(productIds)].sort();
  for (const productId of products) {
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`inventory.stock:${ctx.companyId}:${warehouseId}:${productId}`}, 0))`;
  }
  // Every bucket of the products (Task 28.2: lots and serials too), in one order: product, ubicación, lot, serial (nulls first).
  return ctx.tx<{ id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }[]>`
    select id, product_id, location_id, lot_id, serial_id from inventory.stock_levels
    where company_id = ${ctx.companyId} and warehouse_id = ${warehouseId} and product_id = any(${products}::uuid[])
    order by product_id, location_id nulls first, lot_id nulls first, serial_id nulls first
    for update`;
}

/**
 * Moves the stock of `warehouse` by `deltas`, in the caller's transaction. The rows are locked by lockStock; a bucket (product, ubicación,
 * lot, serial) that does not exist yet is created at zero under that lock (a plain insert: no `seq` is drawn for nothing). The quantity is
 * added in SQL (`on_hand = on_hand + qty`, numeric) and checked under the lock: an untracked bucket that ends below zero refuses the whole
 * movement with `negative_stock_refused`, unless the bodega allows backorders; a lot or serial bucket never goes below zero, whatever the
 * bodega allows (`lot_short`, `serial_not_in_stock`: a lot or serial is a physical thing, Task 28.2). A second transaction waiting on the lock reads what the first committed
 * (READ COMMITTED: each statement after the lock sees the committed rows).
 */
export async function applyStock(ctx: ProcessContext, warehouse: { id: string; allowBackorders: boolean }, deltas: readonly StockDelta[], options: { voiding?: boolean } = {}): Promise<void> {
  const buckets = new Map<string, StockDelta>();
  for (const d of deltas) {
    const key = bucketKey(d);
    const seen = buckets.get(key);
    buckets.set(key, seen ? { ...seen, qty: round4(seen.qty + d.qty) } : { ...d });
  }
  const locked = await lockStock(ctx, warehouse.id, [...buckets.values()].map((d) => d.productId));
  // A serial coming in (a receipt, a return, a void, a transfer or relocation leg: review finding 1) takes the serial's lock after the stock
  // locks (RG-3 order), so the check below that it is on hand nowhere else reads what any other writer of the serial committed.
  const inboundSerials = [...new Set([...buckets.values()].flatMap((d) => (d.serialId && d.qty > 0 ? [d.serialId] : [])))];
  const serialNos = inboundSerials.length === 0 ? [] : await ctx.tx<{ id: string; product_id: string; serial_no: string }[]>`
    select id, product_id, serial_no from inventory.serials where id = any(${inboundSerials}::uuid[])`;
  for (const key of [...new Set(serialNos.map((r) => serialLockKey(ctx.companyId, r.product_id, r.serial_no)))].sort()) {
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
  const rowOf = new Map(locked.map((r) => [bucketKey({ productId: r.product_id, locationId: r.location_id, lotId: r.lot_id, serialId: r.serial_id }), r.id]));
  const missing = [...buckets.entries()].filter(([key]) => !rowOf.has(key));
  if (missing.length > 0) {
    const created = await ctx.tx<{ id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }[]>`
      insert into inventory.stock_levels ${ctx.tx(missing.map(([, d]) => ({
        company_id: ctx.companyId, product_id: d.productId, warehouse_id: warehouse.id, location_id: d.locationId, lot_id: d.lotId ?? null, serial_id: d.serialId ?? null, on_hand: 0,
      })))}
      returning id, product_id, location_id, lot_id, serial_id`;
    for (const r of created) rowOf.set(bucketKey({ productId: r.product_id, locationId: r.location_id, lotId: r.lot_id, serialId: r.serial_id }), r.id);
  }
  const refusals: string[] = [];
  const lotShort: string[] = [];
  const serialsOut: string[] = [];
  for (const [key, d] of [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (d.qty === 0) continue;
    if (d.serialId && d.qty < 0) {
      // A serial leaves only the bucket that holds it: checked before the update, so the 0..1 check never sees −1.
      const [held] = await ctx.tx<{ on_hand: string }[]>`select on_hand::text from inventory.stock_levels where id = ${rowOf.get(key)!}`;
      if (num(held!.on_hand) + d.qty < 0) {
        serialsOut.push(`El serial ${d.label ?? d.serialId} de ${d.sku} no está en esa bodega y ubicación`);
        continue;
      }
    }
    const [row] = await ctx.tx<{ before: string; negative: boolean }[]>`
      update inventory.stock_levels set on_hand = on_hand + ${String(d.qty)}::numeric
      where id = ${rowOf.get(key)!}
      returning (on_hand - ${String(d.qty)}::numeric)::text as before, on_hand < 0 as negative`;
    if (row!.negative && d.qty < 0 && d.lotId) {
      lotShort.push(`El lote ${d.label ?? d.lotId} de ${d.sku} tiene ${qtyText(num(row!.before))} en esa bodega y ubicación y el movimiento saca ${qtyText(-d.qty)}`);
    } else if (row!.negative && d.qty < 0 && !warehouse.allowBackorders) {
      refusals.push(`El producto ${d.sku} tiene ${qtyText(num(row!.before))} en existencia y el movimiento saca ${qtyText(-d.qty)}: la bodega no permite existencias negativas`);
    }
  }
  // Refusing throws, and the transaction rolls back the changed rows.
  if (refusals.length > 0) refuse("negative_stock_refused", refusals);
  if (serialsOut.length > 0) refuse("serial_not_in_stock", serialsOut);
  if (lotShort.length > 0) refuse("lot_short", lotShort);
  // A serial is on hand in one bucket at most, across every bodega (after this movement's own −1 legs, so a transfer or a relocation passes).
  if (inboundSerials.length > 0) {
    const twice = await ctx.tx<{ serial_id: string }[]>`
      select serial_id from inventory.stock_levels where company_id = ${ctx.companyId} and serial_id = any(${inboundSerials}::uuid[])
      group by serial_id having sum(on_hand) > 1 order by serial_id`;
    if (twice.length > 0) {
      const skuOf = new Map([...buckets.values()].flatMap((d) => (d.serialId ? [[d.serialId, d] as const] : [])));
      refuse("serial_exists", twice.map((t) => {
        const d = skuOf.get(t.serial_id);
        const what = `el serial ${d?.label || serialNos.find((r) => r.id === t.serial_id)?.serial_no || t.serial_id} de ${d?.sku ?? ""}`;
        return options.voiding
          ? `No se puede anular: ${what} ya está en existencia en otra bodega o ubicación (volvió a entrar después de este movimiento)`
          : `${what.charAt(0).toUpperCase()}${what.slice(1)} ya está en existencia en otra bodega o ubicación`;
      }));
    }
  }
}

/**
 * Takes the stock locks of several bodegas in one ordered pass: the bodegas in ascending id order, each through lockStock. A process
 * that moves stock in more than one bodega (a traslado: source and transit, transit and destination) calls this before its first
 * movement, so two of them running in opposite directions (A→B and B→A) queue on the lower bodega first instead of deadlocking.
 * Every single-bodega writer already follows the same bodega-then-product order.
 */
export async function lockStockLegs(ctx: ProcessContext, legs: readonly { warehouseId: string; productIds: readonly string[] }[]): Promise<void> {
  const byWarehouse = new Map<string, Set<string>>();
  for (const leg of legs) {
    const set = byWarehouse.get(leg.warehouseId) ?? new Set<string>();
    for (const productId of leg.productIds) set.add(productId);
    byWarehouse.set(leg.warehouseId, set);
  }
  for (const warehouseId of [...byWarehouse.keys()].sort()) await lockStock(ctx, warehouseId, [...byWarehouse.get(warehouseId)!]);
}

/** The lot codes and serial numbers of the buckets named, by id (for the refusals). */
async function bucketLabels(ctx: ProcessContext, buckets: readonly { lotId: string | null; serialId: string | null }[]): Promise<Map<string, string>> {
  const lots = [...new Set(buckets.flatMap((b) => (b.lotId ? [b.lotId] : [])))];
  const serials = [...new Set(buckets.flatMap((b) => (b.serialId ? [b.serialId] : [])))];
  const out = new Map<string, string>();
  if (lots.length > 0) for (const r of await ctx.tx<{ id: string; code: string }[]>`select id, code from inventory.lots where id = any(${lots}::uuid[])`) out.set(r.id, r.code);
  if (serials.length > 0) for (const r of await ctx.tx<{ id: string; serial_no: string }[]>`select id, serial_no from inventory.serials where id = any(${serials}::uuid[])`) out.set(r.id, r.serial_no);
  return out;
}

/** The date a step happened: today in the company's timezone. */
export async function companyToday(ctx: ProcessContext): Promise<string> {
  const [row] = await ctx.tx<{ today: string }[]>`select (now() at time zone timezone)::date::text as today from kernel.companies where id = ${ctx.companyId}`;
  return row!.today;
}

/** Refuses a bodega that holds the company's transit ubicación: stock sits there only between a traslado's ship and receive. */
export async function refuseTransitWarehouse(ctx: ProcessContext, warehouseId: string): Promise<void> {
  const [row] = await ctx.tx`select 1 from inventory.locations where warehouse_id = ${warehouseId} and kind = 'transit' and deleted_at is null limit 1`;
  if (row) refuse("transit_warehouse_refused", ["La bodega de tránsito solo la usan los traslados: elige otra bodega"]);
}

/** The bodega of a movement, as the caller sees it (company RLS); `invalid_input` when there is none. */
export async function warehouseOf(ctx: ProcessContext, warehouseId: string): Promise<{ id: string; allowBackorders: boolean }> {
  const [row] = await ctx.tx<{ id: string; allow_backorders: boolean }[]>`
    select id, allow_backorders from inventory.warehouses where id = ${warehouseId} and deleted_at is null`;
  if (!row) refuse("invalid_warehouse", ["La bodega no existe"]);
  return { id: row.id, allowBackorders: row.allow_backorders };
}

/**
 * The movement that already answers these source lines, if any (a redelivered event), with its real status (saved, or voided when the
 * source undid it). `movableIds` are the source lines of the request that move stock (its skipped lines are never stored): the movement
 * found must hold exactly those, else the request is not a redelivery but another document naming lines that already moved
 * (`duplicate_source_line`).
 */
async function existingForSource(ctx: ProcessContext, sourceEntity: string, sourceLineIds: string[], movableIds: string[], skippedLines: number): Promise<PostedMovement | null> {
  const rows = await ctx.tx<{ id: string; number: string | null; status: "saved" | "voided"; source_line_ids: string[] }[]>`
    select m.id, m.number, m.status,
           (select array_agg(distinct x.source_line_id::text) from inventory.movement_lines x where x.movement_id = m.id and x.source_entity = ${sourceEntity}) as source_line_ids
    from inventory.movements m
    where m.id in (select l.movement_id from inventory.movement_lines l
                   where l.company_id = ${ctx.companyId} and l.source_entity = ${sourceEntity} and l.source_line_id = any(${sourceLineIds}::uuid[]))`;
  if (rows.length === 0) return null;
  if (rows.length > 1) refuse("duplicate_source_line", ["Las líneas de origen ya están en movimientos distintos"]);
  const row = rows[0]!;
  const stored = [...(row.source_line_ids ?? [])].sort();
  const asked = [...new Set(movableIds)].sort();
  if (stored.length !== asked.length || stored.some((v, i) => v !== asked[i])) {
    refuse("duplicate_source_line", [`Las líneas de origen no son las del movimiento ${row.number ?? row.id}, que ya movió parte de ellas`]);
  }
  return { id: row.id, number: row.number, status: row.status, skippedLines };
}

/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The sale issue line each moved line of a sale return returns (`returnOf`: the issue's source line), by index into `moved`; refuses
 * `invalid_return` (naming the request's line) when the named line is not a sale issue line of the same product in the company, when
 * its sale issue was voided, or when the units returned (the saved, not voided, returns already recorded plus this request's lines)
 * would exceed the units it issued. The issue lines are locked (transaction advisory locks, in id order) so two returns of one line
 * cannot both pass the check.
 */
async function returnedLines(ctx: ProcessContext, moved: { line: z.output<typeof movementLineInput>; product: ProductFacts; index: number }[]): Promise<(string | undefined)[]> {
  const asked = moved.flatMap((m, i) => (m.line.returnOf ? [{ i, index: m.index, qty: m.line.qty, ...m.line.returnOf, productId: m.product.id }] : []));
  if (asked.length === 0) return [];
  const found = await ctx.tx<{ id: string; source_entity: string; source_line_id: string; product_id: string; kind: string; status: string; qty: string; location_id: string | null; lot_id: string | null; serial_id: string | null }[]>`
    select l.id, l.source_entity, l.source_line_id, l.product_id, m.kind, m.status, l.qty, l.location_id, l.lot_id, l.serial_id
    from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
    where l.company_id = ${ctx.companyId} and l.source_line_id = any(${asked.map((a) => a.sourceLineId)}::uuid[])
    order by l.line_no`;
  const out: (string | undefined)[] = [];
  const problems: string[] = [];
  for (const a of asked) {
    // The issue line of the returned source line: of the bucket the return names when the issue split it (Task 28.3: the lot or the
    // serial, then the same ubicación), else its only line.
    const fields = moved[a.i]!.line;
    const ofSource = found.filter((f) => f.source_entity === a.sourceEntity && f.source_line_id === a.sourceLineId);
    const ofBucket = ofSource.filter((f) => (fields.lotId === undefined || f.lot_id === fields.lotId) && (fields.serialIds?.length !== 1 || f.serial_id === fields.serialIds[0]));
    const line = ofBucket.find((f) => f.location_id === (fields.locationId ?? null)) ?? ofBucket[0];
    if (!line || line.kind !== "sale_issue" || line.product_id !== a.productId) {
      problems.push(`Línea ${a.index + 1}: la línea devuelta no es una salida por venta de este producto`);
      continue;
    }
    if (line.status === "voided") {
      problems.push(`Línea ${a.index + 1}: la salida por venta que devuelve está anulada`);
      continue;
    }
    out[a.i] = line.id;
  }
  if (problems.length > 0) refuse("invalid_return", problems);

  const issueIds = [...new Set(out.filter((id): id is string => !!id))].sort();
  for (const id of issueIds) await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`inventory.return:${id}`}, 0))`;
  const already = await ctx.tx<{ return_of_line_id: string; qty: string }[]>`
    select l.return_of_line_id, sum(l.qty) as qty
    from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
    where l.company_id = ${ctx.companyId} and l.return_of_line_id = any(${issueIds}::uuid[]) and m.kind = 'sale_return' and m.status <> 'voided'
    group by l.return_of_line_id`;
  const returned = new Map(already.map((r) => [r.return_of_line_id, Number(r.qty)]));
  for (const a of asked) {
    const issueId = out[a.i]!;
    const issued = -Number(found.find((f) => f.id === issueId)!.qty);
    const total = Math.round(((returned.get(issueId) ?? 0) + a.qty) * 1e4) / 1e4;
    returned.set(issueId, total);
    if (total > issued) {
      const left = Math.max(Math.round((issued - (total - a.qty)) * 1e4) / 1e4, 0);
      problems.push(`Línea ${a.index + 1}: se devuelven más unidades de las que salieron (salieron ${issued}, quedan por devolver ${left})`);
    }
  }
  if (problems.length > 0) refuse("invalid_return", problems);
  return out;
}

/**
 * Registers a movement and moves the stock (see the header of this file). Shared by inventory.movement.post and the processes of Task 7
 * (adjustments, transfers), which add their own gates (step-up, reason) before calling it.
 */
export async function postMovement(ctx: ProcessContext, input: MovementInput): Promise<PostedMovement> {
  const sign = KIND_SIGN[input.kind];
  const errors: string[] = [];
  input.lines.forEach((line, i) => {
    if (sign !== 0 && Math.sign(line.qty) !== sign) errors.push(`Línea ${i + 1}: un movimiento de tipo ${input.kind} lleva cantidades ${sign > 0 ? "positivas" : "negativas"}`);
    if (line.sourceLineId && !input.sourceEntity) errors.push(`Línea ${i + 1}: una línea de origen necesita la entidad de origen`);
    if (line.returnOf && input.kind !== "sale_return") errors.push(`Línea ${i + 1}: solo una devolución de venta indica la salida que devuelve`);
  });
  const sourceLineIds = [...new Set(input.lines.flatMap((l) => (l.sourceLineId ? [l.sourceLineId] : [])))];
  // A source line moves each bucket once (Task 28.3: a FEFO split or one line per serial moves several buckets of one delivery line); a
  // line that names no lot or serial is its source line's only line, as before (RG-2).
  const sourceKeys = input.lines.flatMap((l) => {
    if (!l.sourceLineId) return [];
    const tracked = l.lotId !== undefined || l.lot !== undefined || l.serialIds !== undefined || l.serials !== undefined;
    return [tracked ? `${l.sourceLineId}|${l.locationId ?? ""}|${l.lotId ?? l.lot?.code ?? ""}|${(l.serialIds ?? l.serials?.map((x) => x.serialNo) ?? []).join(",")}` : l.sourceLineId];
  });
  if (new Set(sourceKeys).size !== sourceKeys.length) errors.push("Una línea de origen aparece dos veces");
  if (errors.length > 0) refuse("invalid_movement", errors);

  const products = await productFacts(ctx, input.lines.map((l) => l.productId));
  if (input.sourceEntity && sourceLineIds.length > 0) {
    // The lines that move stock: a known product that is not a service and keeps stock (the others are refused or skipped below).
    const moves = (l: z.output<typeof movementLineInput>) => {
      const p = products.get(l.productId);
      return !!p && p.kind !== "service" && p.trackStock;
    };
    const movableIds = input.lines.flatMap((l) => (l.sourceLineId && moves(l) ? [l.sourceLineId] : []));
    const existing = await existingForSource(ctx, input.sourceEntity, sourceLineIds, movableIds, input.lines.filter((l) => !moves(l)).length);
    if (existing) return existing;
  }

  const warehouse = await warehouseOf(ctx, input.warehouseId);
  if (!input.allowTransit) await refuseTransitWarehouse(ctx, warehouse.id);
  const locationIds = [...new Set(input.lines.flatMap((l) => (l.locationId ? [l.locationId] : [])))];
  const locations = locationIds.length === 0 ? [] : await ctx.tx<{ id: string; warehouse_id: string }[]>`
    select id, warehouse_id from inventory.locations where id = any(${locationIds}::uuid[]) and deleted_at is null`;
  const locationWarehouse = new Map(locations.map((l) => [l.id, l.warehouse_id]));

  const services: string[] = [];
  const problems: string[] = [];
  const moved: { line: z.output<typeof movementLineInput>; product: ProductFacts; index: number }[] = [];
  let skippedLines = 0;
  input.lines.forEach((line, i) => {
    const product = products.get(line.productId);
    if (!product) return problems.push(`Línea ${i + 1}: el producto no existe o no es visible`);
    if (product.kind === "service") return services.push(`Línea ${i + 1}: ${product.sku} es un servicio (kind=service): no mueve inventario`);
    if (line.locationId && locationWarehouse.get(line.locationId) !== warehouse.id) return problems.push(`Línea ${i + 1}: la ubicación no es de la bodega del movimiento`);
    if (line.uom && line.uom !== product.uomCode) return problems.push(`Línea ${i + 1}: ${product.sku} se mueve en su unidad ${product.uomCode}, no en ${line.uom}`);
    if (!product.trackStock) {
      skippedLines += 1;
      return;
    }
    moved.push({ line, product, index: i });
  });
  if (services.length > 0) refuse("service_product_refused", services);
  if (problems.length > 0) refuse("invalid_movement", problems);
  if (moved.length === 0) return { id: null, number: null, status: "skipped", skippedLines };

  // Lots and serials (Task 28.2): a tracked product's line names the bucket it moves; a serial line becomes one line per serial. The stock
  // locks come first (the one lock order), then the serials and the nested creates of new lots and serials. An untracked movement moves
  // the bucket without lot or serial, as before (RG-2).
  // The products' tracking locks, shared, before their tracking is read (review finding 2): a tracking change in flight commits first.
  await lockTracking(ctx, moved.map((m) => m.product.id));
  const kinds = await trackingKinds(ctx, moved.map((m) => m.product.id));
  const tracked = [...kinds.values()].some((k) => k !== "none");
  if (tracked) await lockStock(ctx, warehouse.id, moved.map((m) => m.product.id));
  const resolved = await resolveTracked(ctx, moved.map((m, i) => ({ item: i, fields: m.line, product: m.product, index: m.index })), "invalid_movement", kinds);
  const labels = tracked ? await bucketLabels(ctx, resolved) : new Map<string, string>();
  // A source line moves each resolved bucket once (review finding 6): a lot named by id on one line and by code on another is the same
  // bucket, refused here as the request's own duplicate rather than by the database's source key (duplicate_source_line).
  const resolvedKeys = resolved.flatMap((r) => {
    const line = moved[r.item]!.line;
    return line.sourceLineId ? [`${line.sourceLineId}|${line.locationId ?? ""}|${r.lotId ?? ""}|${r.serialId ?? ""}`] : [];
  });
  if (new Set(resolvedKeys).size !== resolvedKeys.length) refuse("invalid_movement", ["Una línea de origen aparece dos veces"]);

  // An adjustment is valued at the line's cost, else the product's standard cost read unmasked (the caller's field visibility never changes a value).
  const standardCosts = input.kind === "adjustment" ? await productCosts(ctx, moved.map((m) => m.product.id), warehouse.id) : new Map<string, number>();
  const returned = await returnedLines(ctx, moved);
  const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
  const [header] = await ctx.tx<{ id: string }[]>`
    insert into inventory.movements ${ctx.tx({
      company_id: ctx.companyId,
      kind: input.kind,
      date: input.date,
      warehouse_id: warehouse.id,
      reference: input.reference ?? null,
      description: input.description ?? null,
      currency: company?.currency_code ?? "COP",
      exchange_rate: 1,
      source_entity: input.sourceEntity ?? null,
      source_id: input.sourceId ?? null,
      party_id: input.kind === "sale_issue" || input.kind === "sale_return" ? (input.partyId ?? null) : null,
      // A movement neither waits for approval nor posts itself (ownFlags): explicit, so the Parámetros switches never apply.
      requires_approval: false,
      posts: false,
    })}
    returning id`;
  const movementId = header!.id;
  const rows = resolved.map((r, n) => {
    const { line, product } = moved[r.item]!;
    return {
      company_id: ctx.companyId,
      movement_id: movementId,
      line_no: n + 1,
      product_id: product.id,
      location_id: line.locationId ?? null,
      lot_id: r.lotId,
      serial_id: r.serialId,
      qty: r.qty,
      uom: product.uomCode,
      // An adjustment is valued: the line's cost, else the product's standard cost (costing, Task 8, brings the weighted average).
      unit_cost: line.unitCost ?? (input.kind === "adjustment" ? (standardCosts.get(product.id) ?? null) : null),
      source_entity: line.sourceLineId ? input.sourceEntity! : null,
      source_line_id: line.sourceLineId ?? null,
      return_of_line_id: returned[r.item] ?? null,
    };
  });
  let inserted: { id: string; line_no: number }[];
  try {
    inserted = await ctx.tx<{ id: string; line_no: number }[]>`insert into inventory.movement_lines ${ctx.tx(rows)} returning id, line_no`;
  } catch (error) {
    // A concurrent delivery of the same source line committed first: the retry of the event finds it and answers it.
    const pg = error as { code?: string; constraint_name?: string };
    if (pg.code === UNIQUE_VIOLATION && pg.constraint_name === "movement_lines_source_key") refuse("duplicate_source_line", ["Esa línea de origen ya movió inventario"]);
    throw error;
  }

  await applyStock(ctx, warehouse, rows.map((r, n) => ({
    productId: r.product_id, locationId: r.location_id, lotId: r.lot_id, serialId: r.serial_id, qty: r.qty, sku: moved[resolved[n]!.item]!.product.sku,
    ...(r.lot_id || r.serial_id ? { label: labels.get((r.serial_id ?? r.lot_id)!) ?? resolved[n]!.serialNo ?? "" } : {}),
  })));
  if (tracked) await moveSerials(ctx, rows.map((r) => ({ serialId: r.serial_id, qty: r.qty })), input.kind === "adjustment");
  await ctx.tx`update inventory.movements set applied_at = now() where id = ${movementId}`;

  // Grabar (draft → saved): the number (on save, D9), the usability of the maestros it names (bodega, ubicaciones, productos), the
  // snapshot and the status event, all in this transaction.
  const saved = await runLifecycle(ctx, ctx.registry.entity(movementEntity.id), movementId, "save");
  const number = saved.number!;
  const lineIds = new Map(inserted.map((r) => [r.line_no, r.id]));
  const event: MovementEvent = {
    movementId,
    number,
    kind: input.kind,
    date: input.date,
    warehouseId: warehouse.id,
    sourceEntity: input.sourceEntity ?? null,
    sourceId: input.sourceId ?? null,
    lines: rows.map((r, i) => ({
      lineId: lineIds.get(r.line_no)!,
      lineNo: r.line_no,
      productId: r.product_id,
      categoryId: moved[resolved[i]!.item]!.product.categoryId,
      warehouseId: warehouse.id,
      locationId: r.location_id,
      qty: r.qty,
      uom: r.uom,
      unitCost: r.unit_cost,
      sourceLineId: r.source_line_id,
      ...(r.return_of_line_id ? { returnOfLineId: r.return_of_line_id } : {}),
      ...(r.lot_id ? { lotId: r.lot_id } : {}),
      ...(r.serial_id ? { serialId: r.serial_id } : {}),
    })),
  };
  if (input.costCenterId && input.kind !== "adjustment") event.costCenterId = input.costCenterId;
  if (input.kind === "adjustment") {
    for (const line of event.lines) {
      line.value = round2(line.qty * (line.unitCost ?? 0));
      if (input.costCenterId) line.costCenterId = input.costCenterId;
    }
    // A line without any cost is worth 0 and the ledger rule posts nothing for it; the flag lets costing (Task 8) raise its cost_missing recommendation.
    if (event.lines.some((line) => line.unitCost === null)) event.costMissing = true;
    event.value = round2(event.lines.reduce((sum, line) => sum + Math.abs(line.value ?? 0), 0));
  }
  await ctx.emit(MOVEMENT_POSTED, event);
  return { id: movementId, number, status: "saved", skippedLines };
}

export const movementPost = defineProcess({
  id: "inventory.movement.post",
  module: "inventory",
  kind: "create",
  feature: FEATURE,
  emits: [MOVEMENT_POSTED],
  description:
    "Registra un movimiento de inventario (entrada, salida, salida por venta o devolución) en una bodega y mueve las existencias en la misma operación; rechaza dejar existencias negativas si la bodega no lo permite y rechaza servicios",
  input: movementInput,
  output: postedOutput,
  // A redelivered event (same source lines) answers the first run (the database keeps the source line unique as well).
  idempotencyKey: (input) => {
    const ids = [...new Set(input.lines.flatMap((l) => (l.sourceLineId ? [l.sourceLineId] : [])))].sort();
    // No source lines, no key: runProcess runs the process without a replay.
    return input.sourceEntity && ids.length > 0 ? `${input.sourceEntity}:${ids.join(",")}` : undefined;
  },
  // A replay answers the movement as it is now (voided when its source undid it), not as it was stored.
  replay: async (tx, stored) => {
    if (!stored.id) return stored;
    const [row] = await tx<{ status: "saved" | "voided" }[]>`select status from inventory.movements where id = ${stored.id}`;
    return row ? { ...stored, status: row.status } : stored;
  },
  handler: (ctx, input) => postMovement(ctx, input),
});

export const movementVoid = defineProcess({
  id: "inventory.movement.void",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  emits: [MOVEMENT_VOIDED],
  description:
    "Anula un movimiento de inventario con el motivo y devuelve sus existencias; se rechaza si la reversión deja existencias negativas en una bodega que no lo permite, y si el movimiento viene de un documento (una entrega, una devolución), que se anula anulando ese documento",
  input: z.object({ id, reason: z.string().trim().min(1, "Indica el motivo").max(1000), expectedUpdatedAt: z.iso.datetime({ offset: true }).optional() }),
  output: z.object({ id: z.string(), status: z.literal("voided"), number: z.string().optional(), updatedAt: z.string().optional() }),
  handler: async (ctx, { id: movementId, reason, expectedUpdatedAt }) => {
    // A movement of a source document (a delivery, a return) follows that document: only the source's event (origin event) undoes it.
    // Voiding it from the UI or the assistant would give the stock back while the delivery stays shipped.
    const [linked] = await ctx.tx<{ source_entity: string | null; kind: MovementKind }[]>`select source_entity, kind from inventory.movements where id = ${movementId}`;
    // An adjustment is corrected by another adjustment (step-up, with its reason): voiding it would give the stock back without the
    // ledger entry the adjustment's event posted. The legs of a traslado follow their traslado.
    if (linked && (linked.kind === "adjustment" || linked.kind === "transfer_out" || linked.kind === "transfer_in" || linked.kind === "relocation")) {
      refuse("movement_kind_not_voidable", [
        linked.kind === "adjustment" ? "Un ajuste no se anula: se corrige con otro ajuste"
          : linked.kind === "relocation" ? "Una reubicación no se anula: se corrige con otra reubicación"
            : "El movimiento es parte de un traslado: no se anula por separado",
      ]);
    }
    if (linked?.source_entity && ctx.origin !== "event") {
      refuse("source_linked_movement", [`El movimiento viene de ${linked.source_entity}: se anula anulando ese documento`]);
    }
    if (linked?.kind === "sale_issue") {
      // A sale issue with returns recorded against it: the returns are voided first (their cost is the issue's). The same locks as a
      // return's check, so a return and the void of its issue cannot both pass.
      const lineIds = await ctx.tx<{ id: string }[]>`select id from inventory.movement_lines where movement_id = ${movementId} order by id`;
      for (const l of lineIds) await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`inventory.return:${l.id}`}, 0))`;
      const returns = await ctx.tx<{ number: string | null }[]>`
        select distinct m.number from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
        where l.company_id = ${ctx.companyId} and l.return_of_line_id = any(${lineIds.map((l) => l.id)}::uuid[]) and m.kind = 'sale_return' and m.status <> 'voided'`;
      if (returns.length > 0) refuse("returns_exist", [`La salida tiene devoluciones registradas (${returns.map((r) => r.number ?? "sin número").join(", ")}): anúlalas primero`]);
    }
    if (linked?.kind === "receipt") {
      // A receipt with landed costs still allocated: the landed cost is voided first (its own reversal posts, inline and strict), so the
      // receipt's void takes out exactly the value its own events put in. KNOWN RACE (Task 14 review, documented): the check reads
      // costing's committed allocations without a lock shared with costing.landed_cost.allocate, so an allocation committing between this
      // read and the void's commit is not seen; costing's void of the receipt then reverses the receipt's own events only and the landed
      // cost's value stays in the layer until that landed cost is voided. A shared lock (receipt id) is the fix when landed costs leave 2B.1.
      const [landed] = await ctx.tx<{ numbers: string[] }[]>`select costing.movement_landed_costs(${movementId}) as numbers`;
      if (landed && landed.numbers.length > 0) refuse("landed_costs_active", [`La entrada tiene costos en destino repartidos (${landed.numbers.join(", ")}): anúlalos primero`]);
    }
    // The lifecycle first: it locks the movement, checks its state and version, writes Anulado, the snapshot and the status event.
    const result = await runLifecycle(ctx, ctx.registry.entity(movementEntity.id), movementId, "void", { reason, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });
    const [movement] = await ctx.tx<{ number: string; kind: MovementKind; date: string; warehouse_id: string; source_entity: string | null; source_id: string | null }[]>`
      select number, kind, date::text as date, warehouse_id, source_entity, source_id from inventory.movements where id = ${movementId}`;
    const lines = await ctx.tx<{ id: string; line_no: number; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; qty: string; uom: string; unit_cost: string | null; source_line_id: string | null }[]>`
      select id, line_no, product_id, location_id, lot_id, serial_id, qty, uom, unit_cost, source_line_id from inventory.movement_lines where movement_id = ${movementId} order by line_no`;
    const products = await productFacts(ctx, lines.map((l) => l.product_id));
    const warehouse = await warehouseOf(ctx, movement!.warehouse_id);
    const labels = await bucketLabels(ctx, lines.map((l) => ({ lotId: l.lot_id, serialId: l.serial_id })));
    await applyStock(ctx, warehouse, lines.map((l) => ({
      productId: l.product_id, locationId: l.location_id, lotId: l.lot_id, serialId: l.serial_id, qty: -num(l.qty), sku: products.get(l.product_id)?.sku ?? l.product_id,
      ...(l.lot_id || l.serial_id ? { label: labels.get((l.serial_id ?? l.lot_id)!) ?? "" } : {}),
    })), { voiding: true });
    // The serials the void moved back (Task 28.2): their status follows the stock.
    await serialsAfterVoid(ctx, movementId, lines.flatMap((l) => (l.serial_id ? [l.serial_id] : [])));
    const event: MovementEvent = {
      movementId,
      number: movement!.number,
      kind: movement!.kind,
      date: movement!.date,
      warehouseId: movement!.warehouse_id,
      sourceEntity: movement!.source_entity,
      sourceId: movement!.source_id,
      voidedOn: await companyToday(ctx),
      lines: lines.map((l) => ({
        lineId: l.id, lineNo: l.line_no, productId: l.product_id, categoryId: products.get(l.product_id)?.categoryId ?? null, warehouseId: movement!.warehouse_id,
        locationId: l.location_id, qty: num(l.qty), uom: l.uom, unitCost: l.unit_cost === null ? null : num(l.unit_cost), sourceLineId: l.source_line_id,
        ...(l.lot_id ? { lotId: l.lot_id } : {}),
        ...(l.serial_id ? { serialId: l.serial_id } : {}),
      })),
    };
    await ctx.emit(MOVEMENT_VOIDED, event);
    return { id: movementId, status: "voided" as const, ...(result.number ? { number: result.number } : {}), ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}) };
  },
});

export const movementConsult = defineProcess({
  id: "inventory.movement.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un movimiento de inventario con sus líneas y los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: movementId }) => {
    const [row] = await ctx.tx`select * from inventory.v_movements where id = ${movementId}`;
    if (!row) throw new ProcessError("not_found", `movement ${movementId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from inventory.v_movement_lines where movement_id = ${movementId} order by line_no`;
    return { ...row, id: movementId, extra: await visibleExtra(ctx, "inventory.movement", row.extra), lines };
  },
});

export const movementLineConsult = defineProcess({
  id: "inventory.movement_line.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de un movimiento de inventario con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from inventory.v_movement_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `movement line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

export const stockLevelConsult = defineProcess({
  id: "inventory.stock_level.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta las existencias de un producto en una bodega y ubicación con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: levelId }) => {
    const [row] = await ctx.tx`select * from inventory.v_stock_levels where id = ${levelId}`;
    if (!row) throw new ProcessError("not_found", `stock level ${levelId} not found`);
    return { ...row, id: levelId };
  },
});

/**
 * The validate hook of a movement (Grabar): a movement reaches the stock only through inventory.movement.post (a Borrador not yet moved
 * is refused), and once in the stock it does not change: correcting it is Anular and registering another (Review Focus 1).
 */
export const movementHooks: TypedHooks = {
  async validate(_ctx, record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (previous.status === "draft" && !record.applied_at) {
      refuse("invalid_movement", ["Un movimiento se registra con «Registrar movimiento», que mueve las existencias"]);
    }
    if (previous.status !== "draft" && data && Object.keys(data).length > 0) {
      refuse("invalid_movement", ["Un movimiento registrado en el inventario no cambia: anúlalo y registra otro"]);
    }
  },
  // inventory.movement_numbers is a system counter (an exception to rule 7, like core.entity_sequences: no id / seq / audit of its own).
  async number(ctx, record) {
    const [row] = await ctx.tx<{ number: string }[]>`select inventory.next_movement_number(${ctx.companyId}, ${KIND_PREFIX[record.kind as MovementKind]}) as number`;
    return row!.number;
  },
};

// -------------------------------------------------------------------------------------------------
// Reubicación (plan 2B.2 Task 29.3, PG §4.3 step 8; migration 0173)
// -------------------------------------------------------------------------------------------------
// inventory.relocation.post moves stock between two ubicaciones of ONE bodega: a movement of kind `relocation` (RU-) with two lines per
// relocated line, − from the source ubicación and + into the destination, the lot and the serial kept (a serial stays `available`: it
// never left the bodega). No quantity of the bodega and no cost changes: costing skips the kind and accounting has no rule for it. A
// ubicación of another bodega is refused (`relocation_cross_warehouse`: that is a traslado); the stock of the source never goes below zero,
// whatever the bodega allows (a relocation moves what is there). Callable from the screen and from the warehouse module's put-away (the
// consumer of warehouse.putaway.confirmed, origin event, idempotent on the event). A relocation is not voided: another one corrects it.

export const PUTAWAY_CONFIRMED = "warehouse.putaway.confirmed";

const relocationLineInput = z.object({
  productId: id,
  /** Where the stock is: a ubicación of the bodega, or null for the bodega's own stock (no ubicación). */
  fromLocationId: id.nullable(),
  /** Where it goes: a storage ubicación of the same bodega. */
  toLocationId: id,
  qty: quantity.refine((n) => n > 0, "La cantidad debe ser mayor que cero"),
  /** A lot-tracked product: the lot moved (it stays the same lot). */
  lotId: id.optional(),
  /** A serial-tracked product: the serial moved (one unit). */
  serialId: id.optional(),
}).strict();

export const relocationInput = z.object({
  warehouseId: id,
  /** Default: today in the company's time zone. */
  date: date.optional(),
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  /** Only the consumer of warehouse.putaway.confirmed: the event's id (a redelivery answers the first run). */
  eventId: id.optional(),
  lines: z.array(relocationLineInput).min(1).max(250),
}).strict();

export async function postRelocation(ctx: ProcessContext, input: z.output<typeof relocationInput>): Promise<PostedMovement> {
  const warehouse = await warehouseOf(ctx, input.warehouseId);
  await refuseTransitWarehouse(ctx, warehouse.id);
  const locationIds = [...new Set(input.lines.flatMap((l) => [l.toLocationId, ...(l.fromLocationId ? [l.fromLocationId] : [])]))];
  const locations = new Map((await ctx.tx<{ id: string; warehouse_id: string; kind: string }[]>`
    select id, warehouse_id, kind from inventory.locations where id = any(${locationIds}::uuid[]) and deleted_at is null`).map((l) => [l.id, l]));
  const products = await productFacts(ctx, input.lines.map((l) => l.productId));
  await lockTracking(ctx, input.lines.map((l) => l.productId));
  const kinds = await trackingKinds(ctx, input.lines.map((l) => l.productId));
  const lotIds = [...new Set(input.lines.flatMap((l) => (l.lotId ? [l.lotId] : [])))];
  const serialIds = [...new Set(input.lines.flatMap((l) => (l.serialId ? [l.serialId] : [])))];
  const lots = new Map((lotIds.length === 0 ? [] : await ctx.tx<{ id: string; product_id: string; code: string }[]>`
    select id, product_id, code from inventory.lots where id = any(${lotIds}::uuid[]) and deleted_at is null`).map((l) => [l.id, l]));
  const serials = new Map((serialIds.length === 0 ? [] : await ctx.tx<{ id: string; product_id: string; serial_no: string }[]>`
    select id, product_id, serial_no from inventory.serials where id = any(${serialIds}::uuid[]) and deleted_at is null`).map((s) => [s.id, s]));

  const problems = new Map<string, string[]>();
  const add = (code: string, text: string) => problems.set(code, [...(problems.get(code) ?? []), text]);
  input.lines.forEach((line, i) => {
    const at = `Línea ${i + 1}`;
    for (const locationId of [line.fromLocationId, line.toLocationId]) {
      if (!locationId) continue;
      const loc = locations.get(locationId);
      if (!loc) add("invalid_movement", `${at}: la ubicación no existe`);
      else if (loc.warehouse_id !== warehouse.id) add("relocation_cross_warehouse", `${at}: la ubicación es de otra bodega; entre bodegas se mueve con un traslado`);
      else if (loc.kind !== "storage") add("invalid_movement", `${at}: la ubicación de tránsito solo la usan los traslados`);
    }
    if (line.fromLocationId === line.toLocationId) add("invalid_movement", `${at}: la ubicación de origen y la de destino son la misma`);
    const product = products.get(line.productId);
    if (!product) return add("invalid_movement", `${at}: el producto no existe o no es visible`);
    if (product.kind === "service") return add("service_product_refused", `${at}: ${product.sku} es un servicio: no tiene existencias`);
    if (!product.trackStock) return add("invalid_movement", `${at}: ${product.sku} no lleva existencias`);
    const kind = kinds.get(product.id) ?? "none";
    if (kind === "lot" && !line.lotId) add("lot_required", `${at}: ${product.sku} se sigue por lote: indica el lote`);
    if (kind === "serial" && !line.serialId) add("serials_required", `${at}: ${product.sku} se sigue por serial: indica el serial`);
    if (kind === "serial" && line.qty !== 1) add("serials_count_mismatch", `${at}: un serial es una unidad`);
    if (kind !== "lot" && line.lotId) add("invalid_movement", `${at}: ${product.sku} no se sigue por lote`);
    if (kind !== "serial" && line.serialId) add("invalid_movement", `${at}: ${product.sku} no se sigue por serial`);
    if (line.lotId && lots.get(line.lotId)?.product_id !== product.id) add("lot_not_found", `${at}: el lote no existe o es de otro producto`);
    if (line.serialId && serials.get(line.serialId)?.product_id !== product.id) add("serial_not_in_stock", `${at}: el serial no existe o es de otro producto`);
  });
  // The bodega's own boundary first (the code the put-away and the screen read), then the rest.
  for (const code of ["relocation_cross_warehouse", ...problems.keys()]) if (problems.has(code)) refuse(code, problems.get(code)!);

  const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
  const date = input.date ?? (await companyToday(ctx));
  const [header] = await ctx.tx<{ id: string }[]>`
    insert into inventory.movements ${ctx.tx({
      company_id: ctx.companyId,
      kind: "relocation",
      date,
      warehouse_id: warehouse.id,
      reference: input.reference ?? null,
      description: input.description ?? null,
      currency: company?.currency_code ?? "COP",
      exchange_rate: 1,
      requires_approval: false,
      posts: false,
    })}
    returning id`;
  const movementId = header!.id;
  const rows = input.lines.flatMap((line, i) => {
    const product = products.get(line.productId)!;
    const base = { company_id: ctx.companyId, movement_id: movementId, product_id: product.id, lot_id: line.lotId ?? null, serial_id: line.serialId ?? null, uom: product.uomCode, unit_cost: null };
    return [
      { ...base, line_no: 2 * i + 1, location_id: line.fromLocationId, qty: -line.qty },
      { ...base, line_no: 2 * i + 2, location_id: line.toLocationId, qty: line.qty },
    ];
  });
  const inserted = await ctx.tx<{ id: string; line_no: number }[]>`insert into inventory.movement_lines ${ctx.tx(rows)} returning id, line_no`;
  // Never below zero in the source, whatever the bodega allows: a relocation moves what is there.
  await applyStock(ctx, { id: warehouse.id, allowBackorders: false }, rows.map((r) => ({
    productId: r.product_id, locationId: r.location_id, lotId: r.lot_id, serialId: r.serial_id, qty: r.qty, sku: products.get(r.product_id)!.sku,
    ...(r.lot_id ? { label: lots.get(r.lot_id)?.code ?? "" } : r.serial_id ? { label: serials.get(r.serial_id)?.serial_no ?? "" } : {}),
  })));
  await ctx.tx`update inventory.movements set applied_at = now() where id = ${movementId}`;
  const saved = await runLifecycle(ctx, ctx.registry.entity(movementEntity.id), movementId, "save");
  const lineIds = new Map(inserted.map((r) => [r.line_no, r.id]));
  const event: MovementEvent = {
    movementId,
    number: saved.number!,
    kind: "relocation",
    date,
    warehouseId: warehouse.id,
    sourceEntity: null,
    sourceId: null,
    lines: rows.map((r) => ({
      lineId: lineIds.get(r.line_no)!, lineNo: r.line_no, productId: r.product_id, categoryId: products.get(r.product_id)!.categoryId, warehouseId: warehouse.id,
      locationId: r.location_id, qty: r.qty, uom: r.uom, unitCost: null, sourceLineId: null,
      ...(r.lot_id ? { lotId: r.lot_id } : {}),
      ...(r.serial_id ? { serialId: r.serial_id } : {}),
    })),
  };
  await ctx.emit(MOVEMENT_POSTED, event);
  return { id: movementId, number: saved.number!, status: "saved", skippedLines: 0 };
}

export const relocationPost = defineProcess({
  id: "inventory.relocation.post",
  module: "inventory",
  kind: "create",
  // It creates a movement (RU-), not a record of an entity of its own name: no record guard, as inventory.adjustment.post.
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event", "ui"],
  emits: [MOVEMENT_POSTED],
  description:
    "Reubica existencias entre dos ubicaciones de una misma bodega (el lote y el serial se conservan); no cambia la cantidad de la bodega ni el costo. Entre bodegas se usa un traslado",
  input: relocationInput,
  output: postedOutput,
  auditInput: (input) => ({ warehouseId: input.warehouseId, lines: input.lines.length }),
  idempotencyKey: (input) => (input.eventId ? `relocation:${input.eventId}` : undefined),
  handler: async (ctx, input) => {
    if (input.eventId && ctx.origin !== "event") refuse("invalid_movement", ["Solo la ubicación confirmada en bodega indica el evento"]);
    return postRelocation(ctx, input);
  },
});

const putawayConfirmedPayload = z.looseObject({
  movementId: id,
  lines: z.array(z.looseObject({
    productId: id, lotId: id.nullable().optional(), serialId: id.nullable().optional(), qty: z.number().positive(), fromLocationId: id.nullable(), toLocationId: id,
  })).min(1),
});

/**
 * Consumer of warehouse.putaway.confirmed (the warehouse module's put-away of a receipt; inventory does not import warehouse): relocates the
 * lines in the receipt's bodega, origin event, as the system user; a redelivered event answers the first run.
 */
export const onPutawayConfirmed: EventConsumer = async (ctx, payload) => {
  const parsed = putawayConfirmedPayload.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `${PUTAWAY_CONFIRMED} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const putaway = parsed.data;
  const [receipt] = await ctx.sql<{ warehouse_id: string; number: string | null }[]>`
    select warehouse_id, number from inventory.movements where company_id = ${ctx.companyId} and id = ${putaway.movementId}`;
  if (!receipt) throw new ProcessError("not_found", `${PUTAWAY_CONFIRMED}: movement ${putaway.movementId} not found`);
  await ctx.runProcess("inventory.relocation.post", {
    warehouseId: receipt.warehouse_id,
    eventId: ctx.event.id,
    reference: `Ubicación de ${receipt.number ?? putaway.movementId}`.slice(0, 100),
    lines: putaway.lines.map((l) => ({
      productId: l.productId, fromLocationId: l.fromLocationId, toLocationId: l.toLocationId, qty: l.qty,
      ...(l.lotId ? { lotId: l.lotId } : {}), ...(l.serialId ? { serialId: l.serialId } : {}),
    })),
  });
};

export const MOVEMENT_PROCESSES = [movementPost, movementVoid, movementConsult, movementLineConsult, stockLevelConsult, relocationPost];
