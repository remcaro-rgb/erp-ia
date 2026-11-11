import { defineProcess, ProcessError, type EventConsumer, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { num, productFacts, qtyText } from "./common";
import { lockStock, MOVEMENT_POSTED, MOVEMENT_VOIDED, postMovement, warehouseOf } from "./movement";
import { ORDER_LINE_SOURCE } from "./sales-orders";

// The stock of the entregas and devoluciones of sales (plan 2B Task 14, design §8.1 steps 3–4). Inventory consumes the sales module's
// events by name (it does not depend on sales; sales never calls inventory, rule 3). Each consumer runs ONE inventory process as the system
// user (origin event), keyed by the event (a redelivered event answers the first run), so everything a delivery does to the stock is one
// transaction:
//   - sales.delivery.shipped → inventory.sale.issue: the sale issue (kind sale_issue, source `sales.delivery`, the entrega lines its source
//     lines, dated the entrega, with the cost center it carries for the cost of sales), then each pedido line's reservation used up by what
//     shipped. A service or a product that keeps no stock moves nothing. Each line leaves from ONE bucket (the bodega's own stock, else the
//     ubicación holding the most, never a transit one), the stock earlier lines of the same entrega took counted, until picking (2B.2).
//     When inventory cannot apply it (no single bucket holds a line: split_location; not enough stock: negative_stock_refused; any other
//     refusal of the movement) nothing moves and inventory emits inventory.sale_issue.refused { deliveryId, deliveryLineId, code, reason }:
//     sales puts the entrega back to open with the reason (never a silent dead letter, Task 14 review). A concurrent run of the same source
//     lines that committed first (duplicate_source_line) is the same movement.
//   - sales.delivery.voided → inventory.sale.void_issue: inventory.movement.void of that sale issue; then, when the event asks (reReserve,
//     Task 43: the owner's «¿Reservar de nuevo las existencias para el pedido?»), the nested inventory.reservation.reserve_again promises
//     the stock back to the pedido lines by what the entrega had used up (all or nothing, only if it suffices; a shortage never fails the
//     void) and inventory.delivery_reservation.restored tells sales the outcome. When there is no issue: nothing to do
//     if every despacho of the entrega was refused (its refused events answer its shipped events), else the shipped event is still on its
//     way and the run fails retryably (handler_failed), so the outbox retries after the issue is posted.
//   - sales.return.received → inventory.sale.return: the sale return (kind sale_return, source `sales.return`, each line `returnOf` the
//     entrega line, so costing re-enters it at the issue's cost), into the bucket the issue left from. Retried while the issue is not posted.
//   - sales.return.voided → inventory.sale.void_return: inventory.movement.void of that sale return. When the stock it brought back already
//     left that bucket, inventory emits inventory.sale_return_void.refused { returnId, code, reason } and sales restores the devolución.
// Products are read through core's published view (core.v_product_stock), never core's tables (rule 3).

/** The source entity of an entrega's movement (sales' DELIVERY_SOURCE; repeated: inventory does not import sales). */
export const DELIVERY_SOURCE = "sales.delivery";
/** The source entity of a devolución's movement. */
export const RETURN_SOURCE = "sales.return";
export const SALE_ISSUE_REFUSED = "inventory.sale_issue.refused";
/** What a sale issue took of each lot and serial (Task 28.3): { deliveryId, lines: [{ deliveryLineId, lotId, lotCode, expiresOn, serialId, serialNo, qty }] }. */
export const SALE_ISSUE_ALLOCATED = "inventory.sale_issue.allocated";
export const SALE_RETURN_VOID_REFUSED = "inventory.sale_return_void.refused";
/** The outcome of the re-reservation a voided entrega asked for (Task 43): { deliveryId, status, short, lines }; sales records it on the entrega. */
export const DELIVERY_RESERVATION_RESTORED = "inventory.delivery_reservation.restored";

const FEATURE = "inventory.stock";
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const uuid = z.uuid();
const eventId = uuid;

const shippedInput = z.object({
  eventId,
  deliveryId: uuid,
  number: z.string().nullable().optional(),
  warehouseId: uuid,
  date: z.iso.date(),
  costCenterId: uuid.optional(),
  /** Task 28.3: a line may name its lot, or (serial products: required) one serial per unit; else a lot product leaves by FEFO. */
  lines: z.array(z.object({ lineId: uuid, orderLineId: uuid.optional(), productId: uuid, qty: z.number().positive(), lotId: uuid.optional(), serialIds: z.array(uuid).min(1).max(500).optional() })).min(1),
});
const voidedInput = z.object({
  eventId,
  deliveryId: uuid,
  reason: z.string().min(1),
  /** Task 43: sales asks to reserve the stock again for the pedido's lines (only when it checked the pedido is open and the caller may reserve). */
  reReserve: z.boolean().optional(),
  warehouseId: uuid.optional(),
  lines: z.array(z.object({ productId: uuid, orderLineId: uuid.optional(), qty: z.number().positive().optional() })),
});
const receivedInput = z.object({
  eventId,
  returnId: uuid,
  number: z.string().nullable().optional(),
  warehouseId: uuid,
  date: z.iso.date(),
  costCenterId: uuid.optional(),
  /** Task 28.3: the lot or the serials coming back (sales defaults them from what the entrega issued); else the issue's own buckets. */
  lines: z.array(z.object({ lineId: uuid, deliveryLineId: uuid, productId: uuid, qty: z.number().positive(), lotId: uuid.optional(), serialIds: z.array(uuid).min(1).max(500).optional() })).min(1),
});
const returnVoidedInput = z.object({ eventId, returnId: uuid, reason: z.string().min(1), lines: z.array(z.object({ productId: uuid })) });

const outcome = z.object({ status: z.enum(["posted", "voided", "refused", "nothing"]), movementId: z.string().nullable() });
type Outcome = z.output<typeof outcome>;

/** The goods that move stock (not a service, keeps stock), read through core's published view. */
async function goodsOf(ctx: ProcessContext, productIds: readonly string[]): Promise<Map<string, { sku: string }>> {
  const facts = await productFacts(ctx, productIds);
  return new Map([...facts.values()].filter((p) => p.kind !== "service" && p.trackStock).map((p) => [p.id, { sku: p.sku }]));
}

/** A refusal of the movement (deterministic: retrying the same event cannot change it), as opposed to a failure to retry. */
const refusalOf = (error: unknown): { code: string; reason: string } | null => {
  if (!(error instanceof ProcessError) || (error.code !== "invalid_input" && error.code !== "invalid_state" && error.code !== "not_found")) return null;
  const code = /^[a-z_]+/.exec(error.message)?.[0] ?? error.code;
  const details = Array.isArray(error.details) ? error.details.filter((d): d is string => typeof d === "string") : [];
  return { code, reason: details.length > 0 ? details.join("; ") : error.message };
};

/** The context's nested run (always present inside a runProcess run). */
const run = (ctx: ProcessContext) => {
  if (!ctx.runProcess) throw new ProcessError("handler_failed", "nested process runs are not available here");
  return ctx.runProcess.bind(ctx);
};

const isDuplicate = (error: unknown) => error instanceof ProcessError && error.code === "invalid_input" && error.message.startsWith("duplicate_source_line");

/** One bucket a line leaves from, and how much. */
interface Pick {
  locationId: string | null;
  lotId: string | null;
  serialId: string | null;
  qty: number;
}
interface PickLine { productId: string; qty: number; sku: string; lineNo: number; lotId?: string | undefined; serialIds?: string[] | undefined }
interface BucketRow {
  product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; on_hand: string;
  lot_code: string | null; expires_on: string | null; produced_on: string | null; lot_status: string | null; lot_deleted: boolean | null; serial_no: string | null;
}

/** A refusal of the issue (deterministic): the first code met, with every line's detail of that code. */
class IssueRefusals {
  private readonly byCode = new Map<string, string[]>();
  add(code: string, detail: string): void {
    this.byCode.set(code, [...(this.byCode.get(code) ?? []), detail]);
  }
  first(): { code: string; reason: string } | null {
    const [entry] = this.byCode.entries();
    return entry ? { code: entry[0], reason: entry[1].join("; ") } : null;
  }
}

/** FEFO order of lots (RG-4): expires_on asc nulls last, produced_on asc nulls last, code asc. */
const fefoOrder = (a: BucketRow, b: BucketRow) =>
  (a.expires_on ?? "9999-12-31").localeCompare(b.expires_on ?? "9999-12-31") ||
  (a.produced_on ?? "9999-12-31").localeCompare(b.produced_on ?? "9999-12-31") ||
  String(a.lot_code).localeCompare(String(b.lot_code));
/** Within one lot: the bodega's own stock first, then the ubicación holding the most. */
const bucketOrder = (left: (r: BucketRow) => number) => (a: BucketRow, b: BucketRow) =>
  (a.location_id === null ? 0 : 1) - (b.location_id === null ? 0 : 1) || left(b) - left(a) || String(a.location_id).localeCompare(String(b.location_id));

/**
 * Picks the buckets each line leaves from, under the stock locks of its products (lockStock), after what earlier lines took:
 *   - an untracked product (RG-2, as before): ONE bucket, the bodega's own stock when it covers the line, else the ubicación (not transit,
 *     not deleted) holding the most; a line no single bucket covers is named (split_location) unless the bodega allows backorders;
 *   - a lot product (Task 28.3, RG-4): the named lot (lot_expired when expired at the date and the product blocks expired lots; lot_blocked
 *     when blocked; lot_short when it holds less), else by FEFO over the lots that are active and not expired (block_expired), split over as
 *     many buckets as it takes (lot_short when they hold less; lot_required when the product turned FEFO off);
 *   - a serial product: the serials named, one per unit, each from the bucket holding it (serials_required, serials_count_mismatch,
 *     serial_not_in_stock). Serials are scanned, never chosen by the system.
 */
async function pickBuckets(ctx: ProcessContext, warehouse: { id: string; allowBackorders: boolean }, date: string, lines: PickLine[]) {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  await lockStock(ctx, warehouse.id, productIds);
  const tracking = new Map((await ctx.tx<{ product_id: string; tracking: string; fefo: boolean; block_expired: boolean }[]>`
    select product_id, tracking, fefo, block_expired from inventory.product_tracking where product_id = any(${productIds}::uuid[])`).map((r) => [r.product_id, r]));
  const rows = await ctx.tx<BucketRow[]>`
    select s.product_id, s.location_id, s.lot_id, s.serial_id, s.on_hand::text,
           lt.code as lot_code, lt.expires_on::text as expires_on, lt.produced_on::text as produced_on, lt.lot_status, lt.deleted_at is not null as lot_deleted, sr.serial_no
    from inventory.stock_levels s
    left join inventory.locations l on l.id = s.location_id
    left join inventory.lots lt on lt.id = s.lot_id
    left join inventory.serials sr on sr.id = s.serial_id
    where s.company_id = ${ctx.companyId} and s.warehouse_id = ${warehouse.id} and s.product_id = any(${productIds}::uuid[])
      and (s.location_id is null or (l.deleted_at is null and l.kind <> 'transit'))`;
  const keyOf = (r: { product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }) => `${r.product_id}|${r.location_id ?? ""}|${r.lot_id ?? ""}|${r.serial_id ?? ""}`;
  const left = new Map(rows.map((r) => [keyOf(r), num(r.on_hand)]));
  const leftOf = (r: BucketRow) => left.get(keyOf(r)) ?? 0;
  const take = (r: BucketRow, qty: number): Pick => {
    left.set(keyOf(r), round4(leftOf(r) - qty));
    return { locationId: r.location_id, lotId: r.lot_id, serialId: r.serial_id, qty };
  };
  const expired = (r: BucketRow, blockExpired: boolean) => blockExpired && r.expires_on !== null && r.expires_on < date;
  /** Fills `qty` from `buckets` in order; null when they hold less (nothing is taken then). */
  const fill = (buckets: BucketRow[], qty: number): Pick[] | null => {
    const total = round4(buckets.reduce((sum, b) => sum + Math.max(leftOf(b), 0), 0));
    if (total < qty) return null;
    const picks: Pick[] = [];
    let need = qty;
    for (const b of buckets) {
      if (need <= 0) break;
      const part = Math.min(need, Math.max(leftOf(b), 0));
      if (part <= 0) continue;
      picks.push(take(b, part));
      need = round4(need - part);
    }
    return picks;
  };

  const refusals = new IssueRefusals();
  const split: string[] = [];
  const picked: Pick[][] = [];
  for (const line of lines) {
    const at = `Línea ${line.lineNo}`;
    const t = tracking.get(line.productId);
    const kind = t?.tracking ?? "none";
    const blockExpired = t?.block_expired ?? true;
    const ofProduct = rows.filter((r) => r.product_id === line.productId);
    if (kind === "lot") {
      const lots = ofProduct.filter((r) => r.lot_id !== null);
      if (line.serialIds) {
        refusals.add("invalid_movement", `${at}: ${line.sku} se sigue por lote, no por serial`);
        picked.push([]);
        continue;
      }
      let buckets: BucketRow[];
      let namedCode: string | null = null;
      if (line.lotId) {
        const named = lots.filter((r) => r.lot_id === line.lotId);
        const [lot] = named.length > 0 ? named : await ctx.tx<BucketRow[]>`
          select ${line.productId}::uuid as product_id, null as location_id, id as lot_id, null as serial_id, '0' as on_hand, code as lot_code,
                 expires_on::text as expires_on, produced_on::text as produced_on, lot_status, deleted_at is not null as lot_deleted, null as serial_no
          from inventory.lots where id = ${line.lotId} and product_id = ${line.productId}`;
        if (!lot) {
          refusals.add("lot_not_found", `${at}: el lote no existe o es de otro producto`);
          picked.push([]);
          continue;
        }
        if (lot.lot_status === "blocked" || lot.lot_deleted) {
          refusals.add("lot_blocked", `${at}: el lote ${lot.lot_code} de ${line.sku} está bloqueado`);
          picked.push([]);
          continue;
        }
        if (expired(lot, blockExpired)) {
          refusals.add("lot_expired", `${at}: el lote ${lot.lot_code} de ${line.sku} venció el ${lot.expires_on}`);
          picked.push([]);
          continue;
        }
        namedCode = lot.lot_code;
        buckets = named.sort(bucketOrder(leftOf));
      } else if (t && !t.fefo) {
        refusals.add("lot_required", `${at}: ${line.sku} se sigue por lote y no sale por FEFO: indica el lote`);
        picked.push([]);
        continue;
      } else {
        buckets = lots.filter((r) => r.lot_status === "active" && !r.lot_deleted && !expired(r, blockExpired))
          .sort((a, b) => fefoOrder(a, b) || bucketOrder(leftOf)(a, b));
      }
      const picks = fill(buckets, line.qty);
      if (!picks) {
        const total = round4(buckets.reduce((sum, b) => sum + Math.max(leftOf(b), 0), 0));
        refusals.add("lot_short", line.lotId
          ? `${at}: el lote ${namedCode ?? ""} de ${line.sku} tiene ${qtyText(total)} en la bodega y la línea saca ${qtyText(line.qty)}`
          : `${at}: los lotes vendibles de ${line.sku} (no bloqueados ni vencidos) suman ${qtyText(total)} en la bodega y la línea saca ${qtyText(line.qty)}`);
        picked.push([]);
        continue;
      }
      picked.push(picks);
      continue;
    }
    if (kind === "serial") {
      if (!line.serialIds || line.serialIds.length === 0) {
        refusals.add("serials_required", `${at}: ${line.sku} se sigue por serial: indica un serial por unidad`);
        picked.push([]);
        continue;
      }
      if (!Number.isInteger(line.qty) || line.serialIds.length !== line.qty || new Set(line.serialIds).size !== line.serialIds.length) {
        refusals.add("serials_count_mismatch", `${at}: la cantidad es ${qtyText(line.qty)} y se indican ${line.serialIds.length} seriales distintos`);
        picked.push([]);
        continue;
      }
      const picks: Pick[] = [];
      for (const serialId of line.serialIds) {
        const holder = ofProduct.find((r) => r.serial_id === serialId && leftOf(r) >= 1);
        if (!holder) {
          const [known] = await ctx.tx<{ serial_no: string }[]>`select serial_no from inventory.serials where id = ${serialId} and product_id = ${line.productId}`;
          refusals.add("serial_not_in_stock", `${at}: el serial ${known?.serial_no ?? serialId} de ${line.sku} no está en la bodega`);
          continue;
        }
        picks.push(take(holder, 1));
      }
      picked.push(picks);
      continue;
    }
    if (line.lotId || line.serialIds) {
      refusals.add("invalid_movement", `${at}: ${line.sku} no se sigue por lote ni por serial`);
      picked.push([]);
      continue;
    }
    // Untracked (RG-2): one bucket per line, as before.
    const buckets = ofProduct.filter((r) => r.lot_id === null && r.serial_id === null);
    const own = buckets.find((b) => b.location_id === null);
    const best = buckets.filter((b) => b.location_id !== null).sort((a, b) => leftOf(b) - leftOf(a) || String(a.location_id).localeCompare(String(b.location_id)))[0];
    let choice: BucketRow | undefined;
    if (own && leftOf(own) >= line.qty) choice = own;
    else if (best && leftOf(best) >= line.qty) choice = best;
    else {
      // Short in total: no split to report, the post refuses it (negative_stock_refused). Enough in total but in no single bucket: split.
      const total = buckets.reduce((sum, b) => sum + leftOf(b), 0);
      if (!warehouse.allowBackorders && total >= line.qty) {
        const most = Math.max(0, ...buckets.map((b) => leftOf(b)));
        split.push(`Línea ${line.lineNo}: ninguna ubicación de la bodega tiene ${line.qty} de ${line.sku} (la que más tiene, ${most}); cada línea sale de una sola ubicación`);
      }
      choice = best && leftOf(best) > (own ? leftOf(own) : 0) ? best : undefined;
    }
    if (choice) picked.push([take(choice, line.qty)]);
    else {
      const key = `${line.productId}|||`;
      left.set(key, round4((left.get(key) ?? 0) - line.qty));
      picked.push([{ locationId: null, lotId: null, serialId: null, qty: line.qty }]);
    }
  }
  return { picked, split, refused: refusals.first() };
}

/**
 * Tells sales what the issue took of each lot and serial (inventory.sale_issue.allocated, Task 28.3), per delivery line and lot or serial
 * (buckets of one lot in two ubicaciones are summed). Only the lines of tracked products; nothing is emitted for an entrega without any,
 * so an untracked entrega's events are as before (RG-2).
 */
async function emitAllocated(ctx: ProcessContext, deliveryId: string, lines: { deliveryLineId: string; picks: Pick[] }[]): Promise<void> {
  const tracked = lines.flatMap((l) => l.picks.filter((p) => p.lotId || p.serialId).map((p) => ({ deliveryLineId: l.deliveryLineId, ...p })));
  if (tracked.length === 0) return;
  const lotIds = [...new Set(tracked.flatMap((t) => (t.lotId ? [t.lotId] : [])))];
  const serialIds = [...new Set(tracked.flatMap((t) => (t.serialId ? [t.serialId] : [])))];
  const lots = new Map((lotIds.length === 0 ? [] : await ctx.tx<{ id: string; code: string; expires_on: string | null }[]>`
    select id, code, expires_on::text from inventory.lots where id = any(${lotIds}::uuid[])`).map((r) => [r.id, r]));
  const serials = new Map((serialIds.length === 0 ? [] : await ctx.tx<{ id: string; serial_no: string }[]>`
    select id, serial_no from inventory.serials where id = any(${serialIds}::uuid[])`).map((r) => [r.id, r.serial_no]));
  const out: { deliveryLineId: string; lotId: string | null; lotCode: string | null; expiresOn: string | null; serialId: string | null; serialNo: string | null; qty: number }[] = [];
  for (const t of tracked) {
    const seen = out.find((o) => o.deliveryLineId === t.deliveryLineId && o.lotId === t.lotId && o.serialId === t.serialId);
    if (seen) {
      seen.qty = round4(seen.qty + t.qty);
      continue;
    }
    const lot = t.lotId ? lots.get(t.lotId) : undefined;
    out.push({
      deliveryLineId: t.deliveryLineId, lotId: t.lotId, lotCode: lot?.code ?? null, expiresOn: lot?.expires_on ?? null,
      serialId: t.serialId, serialNo: t.serialId ? (serials.get(t.serialId) ?? null) : null, qty: t.qty,
    });
  }
  await ctx.emit(SALE_ISSUE_ALLOCATED, { deliveryId, lines: out });
}

/** Posts `input` in a savepoint: a refusal leaves nothing written; a concurrent post of the same source lines answers that movement. */
async function postInSavepoint(ctx: ProcessContext, input: Parameters<typeof postMovement>[1]): Promise<{ id: string | null; created: boolean } | { refused: { code: string; reason: string } }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const posted = await ctx.tx.savepoint((sp) => postMovement({ ...ctx, tx: sp as unknown as ProcessContext["tx"] }, input));
      // The retry after duplicate_source_line answers the movement a concurrent run wrote: not this run's.
      return { id: posted.id, created: attempt === 0 };
    } catch (error) {
      if (isDuplicate(error) && attempt === 0) continue;
      const refused = refusalOf(error);
      if (!refused) throw error;
      return { refused };
    }
  }
}

/** The saved or voided movements of `kind` a sales document posted, oldest first. */
async function movementsOf(ctx: ProcessContext, sourceEntity: string, sourceId: string, kind: string) {
  return ctx.tx<{ id: string; status: string }[]>`
    select id, status from inventory.movements where company_id = ${ctx.companyId} and source_entity = ${sourceEntity} and source_id = ${sourceId} and kind = ${kind}
    order by seq`;
}

export const saleIssue = defineProcess({
  id: "inventory.sale.issue",
  module: "inventory",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_POSTED, SALE_ISSUE_REFUSED, SALE_ISSUE_ALLOCATED],
  description: "Descarga las existencias de una entrega despachada y usa su reserva; si no puede, lo avisa a ventas. Solo lo ejecuta el evento de despacho",
  input: shippedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_issue:${input.eventId}`,
  handler: async (ctx, d): Promise<Outcome> => {
    const goods = await goodsOf(ctx, d.lines.map((l) => l.productId));
    const moving = d.lines.map((l, i) => ({ ...l, lineNo: i + 1 })).filter((l) => goods.has(l.productId));
    let movementId: string | null = null;
    // Whether THIS run issued the stock: only then does it use up the pedido's reservation. A run that finds the movement already there (a
    // redelivery, a duplicated despacho event with another id, a concurrent run) changes nothing more (review round 2, N2: the release is
    // not idempotent per entrega line, a second release of a partial entrega would free stock the pedido still holds).
    let issuedNow = false;
    const existingMovement = async () =>
      (await ctx.tx<{ movement_id: string }[]>`
        select movement_id from inventory.movement_lines where company_id = ${ctx.companyId} and source_entity = ${DELIVERY_SOURCE}
          and source_line_id = any(${moving.map((l) => l.lineId)}::uuid[]) limit 1`)[0]?.movement_id ?? null;
    if (moving.length > 0) {
      // The movement of these lines already posted (a redelivery after a lost answer, a concurrent run): it is the answer.
      const existing = await existingMovement();
      if (existing) movementId = existing;
      else {
        const refuse = async (code: string, reason: string): Promise<Outcome> => {
          await ctx.emit(SALE_ISSUE_REFUSED, { deliveryId: d.deliveryId, deliveryLineId: moving[0]!.lineId, shippedEventId: d.eventId, number: d.number ?? null, code, reason });
          return { status: "refused", movementId: null };
        };
        let warehouse: { id: string; allowBackorders: boolean };
        try {
          warehouse = await warehouseOf(ctx, d.warehouseId);
        } catch (error) {
          const refused = refusalOf(error);
          if (!refused) throw error;
          return refuse(refused.code, refused.reason);
        }
        const { picked, split, refused } = await pickBuckets(ctx, warehouse, d.date, moving.map((l) => ({
          productId: l.productId, qty: l.qty, sku: goods.get(l.productId)!.sku, lineNo: l.lineNo, lotId: l.lotId, serialIds: l.serialIds,
        })));
        // pickBuckets holds the stock lock of every product of the lines: a concurrent run of the same lines has committed by now, and its
        // movement is the answer (no second issue, no second release).
        const committed = await existingMovement();
        if (committed) movementId = committed;
        else {
          if (refused) return refuse(refused.code, refused.reason);
          if (split.length > 0) return refuse("split_location", split.join("; "));
          // One movement line per delivery line and bucket (Task 28.3: a FEFO split, one line per serial); untracked lines as before.
          const movementLines = moving.flatMap((l, i) => picked[i]!.map((p) => ({
            productId: l.productId, qty: -p.qty, sourceLineId: l.lineId,
            ...(p.locationId ? { locationId: p.locationId } : {}),
            ...(p.lotId ? { lotId: p.lotId } : {}),
            ...(p.serialId ? { serialIds: [p.serialId] } : {}),
          })));
          const posted = await postInSavepoint(ctx, {
            kind: "sale_issue",
            date: d.date,
            warehouseId: d.warehouseId,
            sourceEntity: DELIVERY_SOURCE,
            sourceId: d.deliveryId,
            ...(d.number ? { reference: d.number } : {}),
            ...(d.costCenterId ? { costCenterId: d.costCenterId } : {}),
            lines: movementLines,
          } as Parameters<typeof postMovement>[1]);
          if ("refused" in posted) return refuse(posted.refused.code, posted.refused.reason);
          movementId = posted.id;
          issuedNow = posted.created;
          if (issuedNow) await emitAllocated(ctx, d.deliveryId, moving.map((l, i) => ({ deliveryLineId: l.lineId, picks: picked[i]! })));
        }
      }
    }
    // What shipped uses up the pedido line's reservation (a short line reserved less, or nothing: what is left of it is released, or nothing).
    // An entrega of services only moves no stock and releases nothing either.
    if (!issuedNow) return { status: movementId ? "posted" : "nothing", movementId };
    for (const line of d.lines) {
      if (!line.orderLineId || !goods.has(line.productId)) continue;
      await run(ctx)("inventory.reservation.release", { sourceEntity: ORDER_LINE_SOURCE, sourceLineId: line.orderLineId, qty: line.qty });
    }
    return { status: movementId ? "posted" : "nothing", movementId };
  },
});

export const saleVoidIssue = defineProcess({
  id: "inventory.sale.void_issue",
  module: "inventory",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_VOIDED, DELIVERY_RESERVATION_RESTORED],
  description:
    "Anula la salida de inventario de una entrega anulada y reintegra sus existencias; si se pidió, vuelve a reservarlas para el pedido cuando alcanzan. Solo lo ejecuta el evento de anulación",
  input: voidedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_void_issue:${input.eventId}`,
  handler: async (ctx, d): Promise<Outcome> => {
    /** The re-reservation the event asked for, in this transaction after the stock is back, and its outcome for sales (Task 43, R43-1..R43-3). */
    const reReserve = async (nothingUsedUp = false): Promise<void> => {
      if (!d.reReserve) return;
      // R43-15 (review I-2, M-1): an entrega whose issue never posted (all its despachos refused, no tracked line) or was already voided used
      // nothing up: it answers `nothing` without reserving anything, so the entrega's result always resolves and a reservation never doubles.
      if (nothingUsedUp) {
        await ctx.emit(DELIVERY_RESERVATION_RESTORED, { deliveryId: d.deliveryId, voidedEventId: d.eventId, status: "nothing", short: [], lines: [] });
        return;
      }
      const lines = d.lines.flatMap((l) => (l.orderLineId && l.qty !== undefined ? [{ orderLineId: l.orderLineId, productId: l.productId, qty: l.qty }] : []));
      const result = d.warehouseId && lines.length > 0
        ? ((await run(ctx)("inventory.reservation.reserve_again", { deliveryId: d.deliveryId, warehouseId: d.warehouseId, lines })) as { status: string; lines: unknown[]; short: unknown[] })
        : { status: "nothing", lines: [], short: [] };
      await ctx.emit(DELIVERY_RESERVATION_RESTORED, { deliveryId: d.deliveryId, voidedEventId: d.eventId, status: result.status, short: result.short, lines: result.lines });
    };
    const [movement] = await movementsOf(ctx, DELIVERY_SOURCE, d.deliveryId, "sale_issue");
    if (!movement) {
      const goods = await goodsOf(ctx, d.lines.map((l) => l.productId));
      if (goods.size === 0) {
        await reReserve(true);
        return { status: "nothing", movementId: null };
      }
      // Every despacho of the entrega was refused (each shipped event answered by a refused one): no issue ever existed.
      const [count] = await ctx.tx<{ shipped: number; refused: number }[]>`
        select count(*) filter (where event = 'sales.delivery.shipped')::int as shipped, count(*) filter (where event = ${SALE_ISSUE_REFUSED})::int as refused
        from kernel.outbox where company_id = ${ctx.companyId} and event in ('sales.delivery.shipped', ${SALE_ISSUE_REFUSED}) and payload->>'deliveryId' = ${d.deliveryId}`;
      if (count && count.shipped > 0 && count.refused >= count.shipped) {
        await reReserve(true);
        return { status: "nothing", movementId: null };
      }
      // Its sale issue is not posted yet (the shipped event is still on its way): retried by the outbox, never lost.
      throw new ProcessError("handler_failed", `sales.delivery.voided: the sale issue of delivery ${d.deliveryId} is not posted yet`);
    }
    if (movement.status === "voided") {
      await reReserve(true);
      return { status: "voided", movementId: movement.id };
    }
    await run(ctx)("inventory.movement.void", { id: movement.id, reason: `Entrega anulada: ${d.reason}` });
    await reReserve();
    return { status: "voided", movementId: movement.id };
  },
});

export const saleReturn = defineProcess({
  id: "inventory.sale.return",
  module: "inventory",
  kind: "create",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_POSTED],
  description: "Reintegra a la bodega las existencias de una devolución recibida, al costo de la salida original. Solo lo ejecuta el evento de recibo",
  input: receivedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_return:${input.eventId}`,
  handler: async (ctx, r): Promise<Outcome> => {
    const goods = await goodsOf(ctx, r.lines.map((l) => l.productId));
    const moving = r.lines.filter((l) => goods.has(l.productId));
    if (moving.length === 0) return { status: "nothing", movementId: null };
    const [existing] = await ctx.tx<{ movement_id: string }[]>`
      select movement_id from inventory.movement_lines where company_id = ${ctx.companyId} and source_entity = ${RETURN_SOURCE}
        and source_line_id = any(${moving.map((l) => l.lineId)}::uuid[]) limit 1`;
    if (existing) return { status: "posted", movementId: existing.movement_id };
    // Each line re-enters where its sale issue left from; an entrega line whose issue is not posted yet is retried. A tracked line (Task
    // 28.3) re-enters the lot or the serials it names, else the buckets its issue took, in the issue's order, each up to what it issued
    // less what saved returns already brought back.
    const issued = await ctx.tx<{ id: string; source_line_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; qty: string; returned: string }[]>`
      select l.id, l.source_line_id, l.location_id, l.lot_id, l.serial_id, (-l.qty)::text as qty,
             coalesce((select sum(r.qty) from inventory.movement_lines r join inventory.movements rm on rm.id = r.movement_id
                       where r.return_of_line_id = l.id and rm.kind = 'sale_return' and rm.status <> 'voided'), 0)::text as returned
      from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
      where l.company_id = ${ctx.companyId} and l.source_entity = ${DELIVERY_SOURCE} and m.status = 'saved'
        and l.source_line_id = any(${moving.map((l) => l.deliveryLineId)}::uuid[])
      order by l.line_no`;
    if (moving.some((l) => !issued.some((i) => i.source_line_id === l.deliveryLineId))) {
      throw new ProcessError("handler_failed", `sales.return.received: the sale issue of a line of return ${r.returnId} is not posted yet`);
    }
    const free = new Map(issued.map((i) => [i.id, round4(num(i.qty) - num(i.returned))]));
    const returnOf = { sourceEntity: DELIVERY_SOURCE };
    const lines: Record<string, unknown>[] = [];
    const problems: string[] = [];
    moving.forEach((l, n) => {
      const ofLine = issued.filter((i) => i.source_line_id === l.deliveryLineId);
      const tracked = ofLine.some((i) => i.lot_id || i.serial_id);
      if (!tracked) {
        // Untracked (RG-2): one line, where the issue left from, as before.
        const locationId = ofLine[0]!.location_id;
        lines.push({ productId: l.productId, qty: l.qty, sourceLineId: l.lineId, ...(locationId ? { locationId } : {}), returnOf: { ...returnOf, sourceLineId: l.deliveryLineId } });
        return;
      }
      if (l.serialIds) {
        for (const serialId of l.serialIds) {
          const issue = ofLine.find((i) => i.serial_id === serialId && (free.get(i.id) ?? 0) >= 1);
          if (!issue) {
            problems.push(`Línea ${n + 1}: el serial no salió en esa línea de la entrega o ya se devolvió`);
            continue;
          }
          free.set(issue.id, round4(free.get(issue.id)! - 1));
          lines.push({ productId: l.productId, qty: 1, sourceLineId: l.lineId, ...(issue.location_id ? { locationId: issue.location_id } : {}), serialIds: [serialId], returnOf: { ...returnOf, sourceLineId: l.deliveryLineId } });
        }
        if (l.serialIds.length !== l.qty) problems.push(`Línea ${n + 1}: la cantidad es ${qtyText(l.qty)} y se indican ${l.serialIds.length} seriales`);
        return;
      }
      const candidates = ofLine.filter((i) => !l.lotId || i.lot_id === l.lotId);
      let need = l.qty;
      for (const issue of candidates) {
        if (need <= 0) break;
        const part = Math.min(need, Math.max(free.get(issue.id) ?? 0, 0));
        if (part <= 0 || issue.serial_id) continue;
        free.set(issue.id, round4(free.get(issue.id)! - part));
        need = round4(need - part);
        lines.push({ productId: l.productId, qty: part, sourceLineId: l.lineId, ...(issue.location_id ? { locationId: issue.location_id } : {}), lotId: issue.lot_id!, returnOf: { ...returnOf, sourceLineId: l.deliveryLineId } });
      }
      if (need > 0) problems.push(`Línea ${n + 1}: se devuelven más unidades de las que salieron ${l.lotId ? "de ese lote " : ""}en esa línea de la entrega`);
    });
    // Deterministic: dead-lettered with its reason, as any refusal of the return.
    if (problems.length > 0) throw new ProcessError("invalid_input", `invalid_return: ${problems.join("; ")}`, { details: problems });
    const posted = await postInSavepoint(ctx, {
      kind: "sale_return",
      date: r.date,
      warehouseId: r.warehouseId,
      sourceEntity: RETURN_SOURCE,
      sourceId: r.returnId,
      ...(r.number ? { reference: r.number } : {}),
      ...(r.costCenterId ? { costCenterId: r.costCenterId } : {}),
      lines,
    } as Parameters<typeof postMovement>[1]);
    // A return inventory refuses (its issue was voided meanwhile) cannot become valid by retrying: it is dead-lettered with its reason.
    if ("refused" in posted) throw new ProcessError("invalid_input", `${posted.refused.code}: ${posted.refused.reason}`, { details: [posted.refused.reason] });
    return { status: "posted", movementId: posted.id };
  },
});

export const saleVoidReturn = defineProcess({
  id: "inventory.sale.void_return",
  module: "inventory",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  emits: [MOVEMENT_VOIDED, SALE_RETURN_VOID_REFUSED],
  description: "Anula la entrada de inventario de una devolución anulada; si sus existencias ya salieron, lo avisa a ventas. Solo lo ejecuta el evento de anulación",
  input: returnVoidedInput,
  output: outcome,
  idempotencyKey: (input) => `sale_void_return:${input.eventId}`,
  handler: async (ctx, r): Promise<Outcome> => {
    const [movement] = await movementsOf(ctx, RETURN_SOURCE, r.returnId, "sale_return");
    if (!movement) {
      const goods = await goodsOf(ctx, r.lines.map((l) => l.productId));
      if (goods.size === 0) return { status: "nothing", movementId: null };
      throw new ProcessError("handler_failed", `sales.return.voided: the sale return of ${r.returnId} is not posted yet`);
    }
    if (movement.status === "voided") return { status: "voided", movementId: movement.id };
    try {
      // In a savepoint (one connection: the nested run's writes are inside it), so a refusal leaves nothing written.
      await ctx.tx.savepoint(() => run(ctx)("inventory.movement.void", { id: movement.id, reason: `Devolución anulada: ${r.reason}` }));
    } catch (error) {
      const refused = refusalOf(error);
      if (!refused) throw error;
      await ctx.emit(SALE_RETURN_VOID_REFUSED, { returnId: r.returnId, voidedEventId: r.eventId, code: refused.code, reason: refused.reason });
      return { status: "refused", movementId: movement.id };
    }
    return { status: "voided", movementId: movement.id };
  },
});

const withEvent = (ctx: Parameters<EventConsumer>[0], payload: unknown) => ({ ...(payload as Record<string, unknown>), eventId: ctx.event.id });
const pick = <T extends z.ZodObject>(schema: T, value: Record<string, unknown>) => Object.fromEntries(Object.keys(schema.shape).filter((k) => k in value).map((k) => [k, value[k]]));

export const onDeliveryShipped: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.issue", pick(shippedInput, withEvent(ctx, payload)));
};
export const onDeliveryVoided: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.void_issue", pick(voidedInput, withEvent(ctx, payload)));
};
export const onReturnReceived: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.return", pick(receivedInput, withEvent(ctx, payload)));
};
export const onReturnVoided: EventConsumer = async (ctx, payload) => {
  await ctx.runProcess("inventory.sale.void_return", pick(returnVoidedInput, withEvent(ctx, payload)));
};

export const SALE_DELIVERY_PROCESSES = [saleIssue, saleVoidIssue, saleReturn, saleVoidReturn];
