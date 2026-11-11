import { defineProcess, ProcessError, runLifecycle, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { transferEntity } from "../entities";
import { id, idInput, productFacts, quantity, refuse, savedMovementId, type ProductFacts } from "./common";
import { companyToday, lockStockLegs, MOVEMENT_POSTED, postMovement, refuseTransitWarehouse, warehouseOf } from "./movement";
import { lockTracking, resolveTracked } from "./tracked-lines";

// Traslados entre bodegas (plan 2B Task 7, design §8.1, Review Focus 1). A traslado is a documento (numbered TR- on save, lines) that
// moves stock in two steps through the company's transit ubicación, so the stock on its way is never lost nor counted twice:
//   ship    → a `transfer_out` movement in the source bodega and a `transfer_in` movement in the transit ubicación;
//   receive → a `transfer_out` movement from the transit ubicación and a `transfer_in` movement in the destination bodega.
// The transit ubicación (kind `transit`) is the company's: the first ubicación of that kind, or one created on the first ship in a
// bodega `TRANSITO`. Between ship and receive the quantity sits there and shows in inventory.v_stock (location_kind = 'transit').
// Locking: each step takes the stock locks of ALL its legs in one ordered pass (lockStockLegs: bodegas in id order, products in id
// order) before its first movement, so a ship A→B racing the receive of a B→A never holds one leg while waiting for the other.
// The movements carry source `inventory.transfer`; they are not voidable by themselves. A shipped traslado is not voided (receive it).
// Lots and serials (Task 28.2, PG §3.2): a line of a lot-tracked product names an existing lot; a serial-tracked line lists its serials
// (existing ones) and is stored as one line per serial at 1. Ship and receive move the same lot and serial buckets through transit.

const FEATURE = "inventory.stock";
const TRANSIT_CODE = "TRANSITO";

const date = z.iso.date();
const positive = quantity.refine((n) => n > 0, "La cantidad debe ser positiva");

export const transferLineInput = z.object({
  productId: id,
  /** A ubicación of the source bodega; none takes the bodega's own stock. */
  fromLocationId: id.optional(),
  /** A ubicación of the destination bodega; none leaves it in the bodega's own stock. */
  toLocationId: id.optional(),
  qty: positive,
  /** A lot-tracked product (Task 28.2): the lot moved, by id or by its code (an existing lot of the product). */
  lotId: id.optional(),
  lot: z.object({ code: z.string().trim().min(1).max(60) }).strict().optional(),
  /** A serial-tracked product: one serial per unit, by id or by number (stored as one line per serial). */
  serialIds: z.array(id).min(1).max(500).optional(),
  serials: z.array(z.object({ serialNo: z.string().trim().min(1).max(80) }).strict()).min(1).max(500).optional(),
}).strict();

export const transferInput = z.object({
  date,
  fromWarehouseId: id,
  toWarehouseId: id,
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  lines: z.array(transferLineInput).min(1).max(500),
}).strict();

const createdOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  lines: z.array(z.object({ id: z.string(), lineNo: z.number(), productId: z.string() })),
});

const steppedOutput = z.object({ id: z.string(), stage: z.enum(["in_transit", "received"]), movements: z.array(z.string()) });

interface TransferRow {
  id: string;
  number: string | null;
  status: string;
  stage: "requested" | "in_transit" | "received";
  from_warehouse_id: string;
  to_warehouse_id: string;
  transit_location_id: string | null;
}
interface TransferLineRow { id: string; line_no: number; product_id: string; from_location_id: string | null; to_location_id: string | null; lot_id: string | null; serial_id: string | null; qty: string }

/** What a traslado's leg moves of a line: its lot, or its one serial. */
const tracking = (l: TransferLineRow) => ({ ...(l.lot_id ? { lotId: l.lot_id } : {}), ...(l.serial_id ? { serialIds: [l.serial_id] } : {}) });

/** The traslado locked for the step, or `not_found`. */
async function lockTransfer(ctx: ProcessContext, transferId: string): Promise<TransferRow> {
  const [row] = await ctx.tx<TransferRow[]>`
    select id, number, status, stage, from_warehouse_id, to_warehouse_id, transit_location_id from inventory.transfers where id = ${transferId} for update`;
  if (!row) throw new ProcessError("not_found", `transfer ${transferId} not found`);
  return row;
}

async function linesOf(ctx: ProcessContext, transferId: string): Promise<TransferLineRow[]> {
  return ctx.tx<TransferLineRow[]>`
    select id, line_no, product_id, from_location_id, to_location_id, lot_id, serial_id, qty::text from inventory.transfer_lines where transfer_id = ${transferId} order by line_no`;
}

/** Refuses a step on a traslado that is not in the stage the step needs (or is voided). */
function requireStage(t: TransferRow, stage: TransferRow["stage"], step: string): void {
  if (t.status === "voided") refuse("invalid_transfer_stage", [`El traslado ${t.number ?? t.id} está anulado`]);
  if (t.stage !== stage) {
    const names = { requested: "solicitado", in_transit: "en tránsito", received: "recibido" } as const;
    refuse("invalid_transfer_stage", [`El traslado ${t.number ?? t.id} está ${names[t.stage]}: no se puede ${step}`]);
  }
}

/**
 * The company's transit ubicación: the first active one of kind `transit`; none yet, the bodega `TRANSITO` (created if missing) gets
 * one. Serialized by an advisory lock so two first ships do not create two.
 */
export async function ensureTransit(ctx: ProcessContext): Promise<{ warehouseId: string; locationId: string }> {
  await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`inventory.transit:${ctx.companyId}`}, 0))`;
  const [found] = await ctx.tx<{ id: string; warehouse_id: string }[]>`
    select id, warehouse_id from inventory.locations where kind = 'transit' and is_active and deleted_at is null order by seq limit 1`;
  if (found) return { warehouseId: found.warehouse_id, locationId: found.id };
  let [warehouse] = await ctx.tx<{ id: string }[]>`select id from inventory.warehouses where lower(code) = ${TRANSIT_CODE.toLowerCase()} and deleted_at is null`;
  if (!warehouse) {
    [warehouse] = await ctx.tx<{ id: string }[]>`
      insert into inventory.warehouses ${ctx.tx({ company_id: ctx.companyId, code: TRANSIT_CODE, name: "En tránsito", allow_backorders: false, is_active: true, status: "saved", requires_approval: false })}
      returning id`;
  }
  const [taken] = await ctx.tx`select 1 from inventory.locations where warehouse_id = ${warehouse!.id} and lower(code) = ${TRANSIT_CODE.toLowerCase()} and deleted_at is null`;
  if (taken) refuse("transit_location_missing", ["La bodega TRANSITO ya tiene una ubicación con ese código que no es de tipo En tránsito: crea una ubicación de tipo En tránsito"]);
  const [location] = await ctx.tx<{ id: string }[]>`
    insert into inventory.locations ${ctx.tx({ company_id: ctx.companyId, warehouse_id: warehouse!.id, code: TRANSIT_CODE, name: "En tránsito", kind: "transit", is_active: true, status: "saved", requires_approval: false })}
    returning id`;
  return { warehouseId: warehouse!.id, locationId: location!.id };
}

export const transferCreate = defineProcess({
  id: "inventory.transfer.create",
  module: "inventory",
  kind: "create",
  feature: FEATURE,
  description:
    "Crea un traslado de existencias entre dos bodegas (queda solicitado: no mueve nada hasta despacharlo); rechaza servicios y productos que no llevan existencias",
  input: transferInput,
  output: createdOutput,
  handler: async (ctx, input) => {
    const errors: string[] = [];
    if (input.fromWarehouseId === input.toWarehouseId) errors.push("La bodega de origen y la de destino deben ser distintas");
    const from = await warehouseOf(ctx, input.fromWarehouseId);
    const to = await warehouseOf(ctx, input.toWarehouseId);
    await refuseTransitWarehouse(ctx, from.id);
    await refuseTransitWarehouse(ctx, to.id);
    const products = await productFacts(ctx, input.lines.map((l) => l.productId));
    const locationIds = [...new Set(input.lines.flatMap((l) => [l.fromLocationId, l.toLocationId].filter((v): v is string => !!v)))];
    const locations = locationIds.length === 0 ? [] : await ctx.tx<{ id: string; warehouse_id: string; kind: string }[]>`
      select id, warehouse_id, kind from inventory.locations where id = any(${locationIds}::uuid[]) and deleted_at is null`;
    const locationOf = new Map(locations.map((l) => [l.id, l]));
    const services: string[] = [];
    const moved: { line: z.output<typeof transferLineInput>; product: ProductFacts; index: number }[] = [];
    input.lines.forEach((line, i) => {
      const product = products.get(line.productId);
      if (!product) return errors.push(`Línea ${i + 1}: el producto no existe o no es visible`);
      if (product.kind === "service") return services.push(`Línea ${i + 1}: ${product.sku} es un servicio (kind=service): no mueve inventario`);
      if (!product.trackStock) return errors.push(`Línea ${i + 1}: ${product.sku} no lleva existencias`);
      for (const [locationId, warehouseId, side] of [[line.fromLocationId, from.id, "origen"], [line.toLocationId, to.id, "destino"]] as const) {
        if (!locationId) continue;
        const location = locationOf.get(locationId);
        if (!location || location.warehouse_id !== warehouseId) errors.push(`Línea ${i + 1}: la ubicación no es de la bodega de ${side}`);
        else if (location.kind === "transit") errors.push(`Línea ${i + 1}: la ubicación de tránsito la usa el traslado, no se elige`);
      }
      moved.push({ line, product, index: i });
    });
    if (services.length > 0) refuse("service_product_refused", services);
    if (errors.length > 0) refuse("invalid_transfer", errors);
    // A traslado moves stock that exists: it names existing lots and serials (an outbound line of the source bodega), never new ones.
    const resolved = await resolveTracked(ctx, moved.map((m, i) => ({ item: i, fields: { ...m.line, qty: -m.line.qty }, product: m.product, index: m.index })), "invalid_transfer");

    const [header] = await ctx.tx<{ id: string }[]>`
      insert into inventory.transfers ${ctx.tx({
        company_id: ctx.companyId,
        date: input.date,
        from_warehouse_id: from.id,
        to_warehouse_id: to.id,
        reference: input.reference ?? null,
        description: input.description ?? null,
        // A traslado neither waits for approval nor posts itself (ownFlags).
        requires_approval: false,
        posts: false,
      })}
      returning id`;
    const lines = await ctx.tx<{ id: string; line_no: number; product_id: string }[]>`
      insert into inventory.transfer_lines ${ctx.tx(resolved.map((r, i) => {
        const { line, product } = moved[r.item]!;
        return {
          company_id: ctx.companyId,
          transfer_id: header!.id,
          line_no: i + 1,
          product_id: product.id,
          from_location_id: line.fromLocationId ?? null,
          to_location_id: line.toLocationId ?? null,
          lot_id: r.lotId,
          serial_id: r.serialId,
          qty: Math.abs(r.qty),
          uom: product.uomCode,
        };
      }))}
      returning id, line_no, product_id`;
    const saved = await runLifecycle(ctx, ctx.registry.entity(transferEntity.id), header!.id, "save");
    return {
      id: header!.id,
      number: saved.number ?? null,
      status: saved.status,
      lines: lines.map((l) => ({ id: l.id, lineNo: l.line_no, productId: l.product_id })).sort((a, b) => a.lineNo - b.lineNo),
    };
  },
});

export const transferShip = defineProcess({
  id: "inventory.transfer.ship",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  emits: [MOVEMENT_POSTED],
  description:
    "Despacha un traslado: saca las existencias de la bodega de origen y las deja en la ubicación de tránsito (dos movimientos); rechaza dejar existencias negativas si la bodega de origen no lo permite",
  input: idInput,
  output: steppedOutput,
  handler: async (ctx, { id: transferId }) => {
    const t = await lockTransfer(ctx, transferId);
    requireStage(t, "requested", "despachar");
    const lines = await linesOf(ctx, transferId);
    const transit = await ensureTransit(ctx);
    const productIds = lines.map((l) => l.product_id);
    // The tracking locks (shared) before the stock locks, the order postMovement and the sale issue follow: a tracking change waiting on
    // the product never stalls behind a transfer holding its stock locks.
    await lockTracking(ctx, productIds);
    // Every leg in one ordered pass, before the first movement.
    await lockStockLegs(ctx, [{ warehouseId: t.from_warehouse_id, productIds }, { warehouseId: transit.warehouseId, productIds }]);
    const when = await companyToday(ctx);
    const base = { date: when, sourceEntity: transferEntity.id, sourceId: transferId, reference: t.number ?? undefined };
    const out = await postMovement(ctx, {
      ...base, kind: "transfer_out", warehouseId: t.from_warehouse_id,
      lines: lines.map((l) => ({ productId: l.product_id, ...(l.from_location_id ? { locationId: l.from_location_id } : {}), qty: -Number(l.qty), ...tracking(l) })),
    });
    const into = await postMovement(ctx, {
      ...base, kind: "transfer_in", warehouseId: transit.warehouseId, allowTransit: true,
      lines: lines.map((l) => ({ productId: l.product_id, locationId: transit.locationId, qty: Number(l.qty), ...tracking(l) })),
    });
    const movements = [savedMovementId(out, "La salida del traslado"), savedMovementId(into, "La entrada a tránsito")];
    await ctx.tx`update inventory.transfers set stage = 'in_transit', shipped_at = now(), transit_location_id = ${transit.locationId} where id = ${transferId}`;
    return { id: transferId, stage: "in_transit" as const, movements };
  },
});

export const transferReceive = defineProcess({
  id: "inventory.transfer.receive",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  emits: [MOVEMENT_POSTED],
  description: "Recibe un traslado despachado: saca las existencias de la ubicación de tránsito y las deja en la bodega de destino (dos movimientos)",
  input: idInput,
  output: steppedOutput,
  handler: async (ctx, { id: transferId }) => {
    const t = await lockTransfer(ctx, transferId);
    requireStage(t, "in_transit", "recibir");
    const lines = await linesOf(ctx, transferId);
    const [transit] = await ctx.tx<{ id: string; warehouse_id: string }[]>`select id, warehouse_id from inventory.locations where id = ${t.transit_location_id}`;
    if (!transit) refuse("transit_location_missing", ["No se encuentra la ubicación de tránsito del traslado"]);
    const productIds = lines.map((l) => l.product_id);
    // The tracking locks (shared) before the stock locks, the order postMovement and the sale issue follow: a tracking change waiting on
    // the product never stalls behind a transfer holding its stock locks.
    await lockTracking(ctx, productIds);
    await lockStockLegs(ctx, [{ warehouseId: transit.warehouse_id, productIds }, { warehouseId: t.to_warehouse_id, productIds }]);
    const when = await companyToday(ctx);
    const base = { date: when, sourceEntity: transferEntity.id, sourceId: transferId, reference: t.number ?? undefined };
    const out = await postMovement(ctx, {
      ...base, kind: "transfer_out", warehouseId: transit.warehouse_id, allowTransit: true,
      lines: lines.map((l) => ({ productId: l.product_id, locationId: transit.id, qty: -Number(l.qty), ...tracking(l) })),
    });
    const into = await postMovement(ctx, {
      ...base, kind: "transfer_in", warehouseId: t.to_warehouse_id,
      lines: lines.map((l) => ({ productId: l.product_id, ...(l.to_location_id ? { locationId: l.to_location_id } : {}), qty: Number(l.qty), ...tracking(l) })),
    });
    const movements = [savedMovementId(out, "La salida de tránsito"), savedMovementId(into, "La entrada al destino")];
    await ctx.tx`update inventory.transfers set stage = 'received', received_at = now() where id = ${transferId}`;
    return { id: transferId, stage: "received" as const, movements };
  },
});

export const transferVoid = defineProcess({
  id: "inventory.transfer.void",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  description: "Anula un traslado con el motivo mientras está solicitado (aún no se despacha); uno despachado se recibe, no se anula",
  input: z.object({ id, reason: z.string().trim().min(1, "Indica el motivo").max(1000), expectedUpdatedAt: z.iso.datetime({ offset: true }).optional() }),
  output: z.object({ id: z.string(), status: z.literal("voided"), number: z.string().optional(), updatedAt: z.string().optional() }),
  handler: async (ctx, { id: transferId, reason, expectedUpdatedAt }) => {
    requireStage(await lockTransfer(ctx, transferId), "requested", "anular");
    const result = await runLifecycle(ctx, ctx.registry.entity(transferEntity.id), transferId, "void", { reason, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });
    return { id: transferId, status: "voided" as const, ...(result.number ? { number: result.number } : {}), ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}) };
  },
});

export const transferConsult = defineProcess({
  id: "inventory.transfer.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un traslado con sus líneas y los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: transferId }) => {
    const [row] = await ctx.tx`select * from inventory.v_transfers where id = ${transferId}`;
    if (!row) throw new ProcessError("not_found", `transfer ${transferId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from inventory.v_transfer_lines where transfer_id = ${transferId} order by line_no`;
    return { ...row, id: transferId, lines };
  },
});

export const transferLineConsult = defineProcess({
  id: "inventory.transfer_line.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de un traslado con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from inventory.v_transfer_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `transfer line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/**
 * The hooks of a traslado: a saved one does not change (its stage moves with ship and receive, not with Grabar), and the number is
 * drawn on save from the company counter (prefix TR-).
 */
export const transferHooks: TypedHooks = {
  async validate(_ctx, _record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (previous.status !== "draft" && data && Object.keys(data).length > 0) {
      refuse("invalid_transfer", ["Un traslado registrado no cambia: anúlalo y registra otro"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select inventory.next_movement_number(${ctx.companyId}, 'TR-') as number`;
    return row!.number;
  },
};

export const TRANSFER_PROCESSES = [transferCreate, transferShip, transferReceive, transferVoid, transferConsult, transferLineConsult];
