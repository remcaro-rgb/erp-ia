import { ProcessError, type ProcessContext } from "@erp/kernel";
import type { TrackingKind } from "../entities";
import { refuse, type ProductFacts } from "./common";

// Lot and serial lines of a movement (plan 2B.2 Task 28.2, PG §3.2; RG-2, RG-3). Resolves what each line of a tracked product names into
// the buckets it moves: a lot-tracked line moves one lot (an existing `lotId`, or `lot.code`: an existing lot of the product whatever its
// case, else, on an inbound line, a new lot created nested through inventory.lot.create in the same chain); a serial-tracked line lists
// one serial per unit (`serialIds`, or `serials` by number: on an inbound line a new number is created nested through
// inventory.serial.create) and becomes one line per serial at ±1. An untracked product names neither and moves the bucket without lot or
// serial, byte for byte as before (RG-2). Serial buckets carry no lot: the serial's lot is an attribute of the serial.
// Refusal codes (the plan's «Interfaces · Produces»): lot_required, expiry_required (from inventory.lot.create), serials_required,
// serials_count_mismatch, serial_exists (an inbound serial already available), serial_not_in_stock (an outbound serial not available).

/** What a movement line may name about lots and serials (movementLineInput's tracking fields). */
export interface TrackingFields {
  lotId?: string | undefined;
  lot?: { code: string; expiresOn?: string | undefined; producedOn?: string | undefined } | undefined;
  serialIds?: string[] | undefined;
  serials?: { serialNo: string }[] | undefined;
  qty: number;
  sourceLineId?: string | undefined;
}

/** One line after resolution: the bucket's lot and serial (null when untracked) and its quantity (±1 for a serial). */
export interface ResolvedLine<T> {
  item: T;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  /** The serial's number, for the messages. */
  serialNo?: string;
}

/**
 * The product-level tracking lock (review finding 2): inventory.product_tracking.set takes it EXCLUSIVE before its stock check; every
 * writer that reads a product's tracking to decide the buckets it moves (postMovement, the sale issue's pick) takes it SHARED before that
 * read, products in ascending id order. Shared holders never block one another (whatever stock locks they hold), so a movement and a
 * tracking change queue, and the second reads what the first committed: an untracked receipt can never leave a lot-less bucket in a
 * product that just turned lot-tracked. A transaction advisory lock: it covers a product with no tracking row yet.
 */
export async function lockTracking(ctx: ProcessContext, productIds: readonly string[], mode: "shared" | "exclusive" = "shared"): Promise<void> {
  for (const productId of [...new Set(productIds)].sort()) {
    const key = `inventory.tracking:${ctx.companyId}:${productId}`;
    if (mode === "exclusive") await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    else await ctx.tx`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
  }
}

/** The advisory lock key of a serial, by product and number (any case), shared by every writer of the serial (RG-3). */
export const serialLockKey = (companyId: string, productId: string, serialNo: string) => `inventory.serial:${companyId}:${productId}:${serialNo.trim().toLowerCase()}`;

/** The tracking kind of each product (none without a row). */
export async function trackingKinds(ctx: ProcessContext, productIds: readonly string[]): Promise<Map<string, TrackingKind>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx<{ product_id: string; tracking: TrackingKind }[]>`
    select product_id, tracking from inventory.product_tracking where product_id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.product_id, r.tracking]));
}

/** Collects refusals by code and throws the first code with all its details (the code the caller reads leads the message). */
class Refusals {
  private readonly byCode = new Map<string, string[]>();
  add(code: string, detail: string): void {
    this.byCode.set(code, [...(this.byCode.get(code) ?? []), detail]);
  }
  throwAny(): void {
    const [first] = this.byCode.entries();
    if (first) refuse(first[0], first[1]);
  }
}

async function nested<T>(ctx: ProcessContext, processId: string, input: unknown): Promise<T> {
  if (!ctx.runProcess) throw new ProcessError("handler_failed", `inventory movements need a context that can run ${processId}`);
  const out = await ctx.runProcess<T>(processId, input);
  // A nested run set to «continue» resolves undefined after queuing its failure: the movement needs the record, so it fails (Task 32).
  if (!out) throw new ProcessError("handler_failed", `the movement needs the record ${processId} did not create`);
  return out;
}

/**
 * Resolves the lots and serials of `lines` (each with its product) for a movement whose sign per line is `qty`'s; the caller holds the
 * stock locks of the products (lockStock) when the lines move stock. Runs the nested creates
 * (new lots and serials of inbound lines) only once every line passed. `refusalCode` is the caller's code for a line that names what its
 * product does not track (invalid_movement, invalid_transfer…).
 */
export async function resolveTracked<T>(
  ctx: ProcessContext,
  lines: readonly { item: T; fields: TrackingFields; product: ProductFacts; index: number }[],
  refusalCode: string,
  known?: Map<string, TrackingKind>,
): Promise<ResolvedLine<T>[]> {
  const kinds = known ?? (await trackingKinds(ctx, lines.map((l) => l.product.id)));
  const errors = new Refusals();
  const productIds = [...new Set(lines.map((l) => l.product.id))];
  const lotsAsked = lines.filter((l) => kinds.get(l.product.id) === "lot");
  const serialsAsked = lines.filter((l) => kinds.get(l.product.id) === "serial");

  type LotRow = { id: string; product_id: string; code: string; expires_on: string | null };
  // Each lot named by code (review finding 5), by product and code in ascending order, before the lots are read: two receipts of one new
  // code in two bodegas (no stock lock in common) queue, and the second finds the lot the first created instead of failing lot_exists.
  const lotKeys = [...new Set(lotsAsked.flatMap((l) => (l.fields.lot ? [`${l.product.id}:${l.fields.lot.code.trim().toLowerCase()}`] : [])))].sort();
  for (const key of lotKeys) await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`inventory.lot:${ctx.companyId}:${key}`}, 0))`;
  const lots: LotRow[] = lotsAsked.length === 0 ? [] : await ctx.tx<LotRow[]>`
    select id, product_id, code, expires_on::text from inventory.lots where product_id = any(${productIds}::uuid[]) and deleted_at is null`;
  // Lock order (RG-3): the caller holds the stock locks of the products (lockStock); then each serial named, by product and number in
  // ascending order (a transaction advisory lock, which covers a number not registered yet), so two movements of one serial queue and
  // the second reads the status the first left.
  if (serialsAsked.length > 0) {
    const byId = serialsAsked.flatMap((l) => l.fields.serialIds ?? []);
    const numbered = byId.length === 0 ? [] : await ctx.tx<{ product_id: string; serial_no: string }[]>`
      select product_id, serial_no from inventory.serials where id = any(${byId}::uuid[])`;
    const keys = [...new Set([
      ...numbered.map((s) => `${s.product_id}:${s.serial_no.toLowerCase()}`),
      ...serialsAsked.flatMap((l) => (l.fields.serials ?? []).map((s) => `${l.product.id}:${s.serialNo.trim().toLowerCase()}`)),
    ])].sort();
    for (const key of keys) await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`inventory.serial:${ctx.companyId}:${key}`}, 0))`; // = serialLockKey
  }
  const serials = serialsAsked.length === 0 ? [] : await ctx.tx<{ id: string; product_id: string; serial_no: string; serial_status: string | null }[]>`
    select id, product_id, serial_no, serial_status from inventory.serials where product_id = any(${productIds}::uuid[]) and deleted_at is null`;

  type Plan = { line: (typeof lines)[number]; lotId?: string; newLot?: TrackingFields["lot"]; serials?: { id?: string; serialNo: string }[] };
  const plans: Plan[] = [];
  const seenSerials = new Set<string>();
  for (const line of lines) {
    const { fields, product, index } = line;
    const at = `Línea ${index + 1}`;
    const kind = kinds.get(product.id) ?? "none";
    const namesLot = fields.lotId !== undefined || fields.lot !== undefined;
    const namesSerials = fields.serialIds !== undefined || fields.serials !== undefined;
    const inbound = fields.qty > 0;
    if (kind === "none") {
      if (namesLot || namesSerials) errors.add(refusalCode, `${at}: ${product.sku} no se sigue por lote ni por serial`);
      plans.push({ line });
      continue;
    }
    if (kind === "lot") {
      if (namesSerials) errors.add(refusalCode, `${at}: ${product.sku} se sigue por lote, no por serial`);
      if (fields.lotId) {
        const lot = lots.find((l) => l.id === fields.lotId && l.product_id === product.id);
        if (!lot) errors.add("lot_not_found", `${at}: el lote no existe o es de otro producto`);
        plans.push({ line, ...(lot ? { lotId: lot.id } : {}) });
      } else if (fields.lot) {
        const asked = fields.lot;
        const lot = lots.find((l) => l.product_id === product.id && l.code.toLowerCase() === asked.code.trim().toLowerCase());
        if (lot) {
          if (asked.expiresOn && lot.expires_on && asked.expiresOn !== lot.expires_on) {
            errors.add(refusalCode, `${at}: el lote ${lot.code} vence el ${lot.expires_on}, no el ${asked.expiresOn}`);
          }
          plans.push({ line, lotId: lot.id });
        } else if (inbound) plans.push({ line, newLot: asked });
        else {
          errors.add("lot_not_found", `${at}: ${product.sku} no tiene el lote ${asked.code}`);
          plans.push({ line });
        }
      } else {
        errors.add("lot_required", `${at}: ${product.sku} se sigue por lote: indica el lote`);
        plans.push({ line });
      }
      continue;
    }
    // Serial-tracked.
    if (namesLot) errors.add(refusalCode, `${at}: ${product.sku} se sigue por serial: indica los seriales, no un lote`);
    if (fields.serialIds && fields.serials) errors.add(refusalCode, `${at}: indica los seriales por id o por número, no ambos`);
    const asked: { id?: string; serialNo?: string }[] = fields.serialIds?.map((id) => ({ id })) ?? fields.serials?.map((s) => ({ serialNo: s.serialNo.trim() })) ?? [];
    if (asked.length === 0) {
      errors.add("serials_required", `${at}: ${product.sku} se sigue por serial: lista un serial por unidad`);
      plans.push({ line });
      continue;
    }
    if (!Number.isInteger(fields.qty) || Math.abs(fields.qty) !== asked.length) {
      errors.add("serials_count_mismatch", `${at}: la cantidad es ${Math.abs(fields.qty)} y se listan ${asked.length} seriales`);
      plans.push({ line });
      continue;
    }
    if (fields.sourceLineId && asked.length > 1) errors.add(refusalCode, `${at}: una línea de origen con seriales lleva un serial por línea`);
    const resolved: { id?: string; serialNo: string }[] = [];
    for (const a of asked) {
      const found = a.id
        ? serials.find((s) => s.id === a.id && s.product_id === product.id)
        : serials.find((s) => s.product_id === product.id && s.serial_no.toLowerCase() === a.serialNo!.toLowerCase());
      const label = found?.serial_no ?? a.serialNo ?? a.id!;
      const key = `${product.id}|${label.toLowerCase()}`;
      if (seenSerials.has(key)) errors.add(refusalCode, `${at}: el serial ${label} aparece dos veces`);
      seenSerials.add(key);
      if (inbound) {
        if (found?.serial_status === "available") errors.add("serial_exists", `${at}: el serial ${label} de ${product.sku} ya está en existencia`);
        else if (!found && a.id) errors.add(refusalCode, `${at}: el serial no existe o es de otro producto`);
      } else if (!found || found.serial_status !== "available") {
        errors.add("serial_not_in_stock", `${at}: el serial ${label} de ${product.sku} no está en existencia`);
      }
      resolved.push(found ? { id: found.id, serialNo: found.serial_no } : { serialNo: label });
    }
    plans.push({ line, serials: resolved });
  }
  errors.throwAny();

  // Every line passed: create the new lots and serials nested (own permission, same chain, rule 1).
  const out: ResolvedLine<T>[] = [];
  for (const plan of plans) {
    const { item, fields, product } = plan.line;
    if (plan.newLot) {
      const created = await nested<{ id: string }>(ctx, "inventory.lot.create", {
        productId: product.id, code: plan.newLot.code,
        ...(plan.newLot.expiresOn ? { expiresOn: plan.newLot.expiresOn } : {}),
        ...(plan.newLot.producedOn ? { producedOn: plan.newLot.producedOn } : {}),
      });
      // Two lines of one movement naming the same new code: the second finds the first's lot.
      lots.push({ id: created.id, product_id: product.id, code: plan.newLot.code, expires_on: plan.newLot.expiresOn ?? null });
      for (const later of plans) {
        if (later !== plan && later.newLot && later.line.product.id === product.id && later.newLot.code.trim().toLowerCase() === plan.newLot.code.trim().toLowerCase()) {
          later.newLot = undefined;
          later.lotId = created.id;
        }
      }
      plan.lotId = created.id;
    }
    if (plan.serials) {
      const sign = Math.sign(fields.qty);
      for (const s of plan.serials) {
        const serialId = s.id ?? (await nested<{ id: string }>(ctx, "inventory.serial.create", { productId: product.id, serialNo: s.serialNo })).id;
        out.push({ item, lotId: null, serialId, qty: sign, serialNo: s.serialNo });
      }
      continue;
    }
    out.push({ item, lotId: plan.lotId ?? null, serialId: null, qty: fields.qty });
  }
  return out;
}

/**
 * Sets the status of the serials a movement moved (RG-3): an inbound line makes it `available`; an outbound one `issued`, or `scrapped`
 * when the movement is an adjustment (a write-off).
 */
export async function moveSerials(ctx: ProcessContext, lines: readonly { serialId: string | null; qty: number }[], adjustment: boolean): Promise<void> {
  const inbound = lines.flatMap((l) => (l.serialId && l.qty > 0 ? [l.serialId] : []));
  const outbound = lines.flatMap((l) => (l.serialId && l.qty < 0 ? [l.serialId] : []));
  if (inbound.length > 0) await ctx.tx`update inventory.serials set serial_status = 'available' where id = any(${inbound}::uuid[])`;
  if (outbound.length > 0) await ctx.tx`update inventory.serials set serial_status = ${adjustment ? "scrapped" : "issued"} where id = any(${outbound}::uuid[])`;
}

/**
 * The serials of a voided movement after its stock was reversed: a serial back on hand is `available`; one taken off hand by voiding its
 * receipt goes back to what its latest outbound movement left (`scrapped` by an adjustment, else `issued`), or to no status when it was
 * never issued (registered and received only by the voided movement).
 */
export async function serialsAfterVoid(ctx: ProcessContext, movementId: string, serialIds: readonly string[]): Promise<void> {
  if (serialIds.length === 0) return;
  await ctx.tx`
    update inventory.serials s set serial_status = case
      when coalesce((select sum(b.on_hand) from inventory.stock_levels b where b.serial_id = s.id), 0) > 0 then 'available'
      else (select case when m.kind = 'adjustment' then 'scrapped' else 'issued' end
            from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
            where l.serial_id = s.id and l.qty < 0 and m.status <> 'voided' and m.id <> ${movementId}
            order by m.seq desc, l.line_no desc limit 1)
    end
    where s.id = any(${[...serialIds]}::uuid[])`;
}
