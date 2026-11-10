import { defineProcess, ProcessError, runLifecycle, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { countEntity } from "../entities";
import { postAdjustment } from "./adjustment";
import { id, idInput, num, productFacts, quantity, refuse, savedMovementId, type ProductFacts } from "./common";
import { companyToday, MOVEMENT_POSTED, refuseTransitWarehouse, warehouseOf } from "./movement";
import { resolveTracked, trackingKinds } from "./tracked-lines";

// Conteos físicos (plan 2B Task 7, design §8.1). A conteo is a documento (numbered CT- on save, lines):
//   create → lists what to count in a bodega (product, and the ubicación when it is counted by ubicación);
//   record → stores, per line, what was counted and what the system held in that bucket at that moment; the difference is
//            counted − system (a line without ubicación is the bodega's own, unlocated stock, as in the movements);
//   apply  → STEP-UP: posts the non-zero differences as exactly ONE adjustment (sign = the difference's) and closes the count; a count
//            applied is final: re-applying and recording again are refused (`count_already_applied`), and two concurrent applies
//            queue on the count row so only the first posts. Source lines make the adjustment idempotent in the database as well.
// The difference is measured at record time, so movements after it are not undone by applying.
// Lots and serials (Task 28.2, PG §3.2): a count line is one bucket (product, ubicación, lot, serial). create lists, for a tracked product,
// every lot or serial with stock at that ubicación; record also takes what the counter found that the sheet does not list (a lot, by id
// or by a new code, created nested; a serial scanned, registered nested when new), each becoming a line of its own; apply posts one
// adjustment line per bucket difference (a serial missing: −1, scrapped; a serial found: +1, available).

const FEATURE = "inventory.stock";

const date = z.iso.date();

export const countLineInput = z.object({ productId: id, locationId: id.optional() }).strict();

export const countInput = z.object({
  date,
  warehouseId: id,
  description: z.string().trim().max(500).optional(),
  lines: z.array(countLineInput).min(1).max(1000),
}).strict();

const createdOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  lines: z.array(z.object({ id: z.string(), lineNo: z.number(), productId: z.string(), locationId: z.string().nullable(), lotId: z.string().nullable(), serialId: z.string().nullable() })),
});

/** What the counter found that the count sheet does not list (Task 28.2): a lot (by id, or a code, new or not) or a serial scanned. */
export const foundInput = z.object({
  productId: id,
  locationId: id.optional(),
  lotId: id.optional(),
  lot: z.object({ code: z.string().trim().min(1).max(60), expiresOn: date.optional(), producedOn: date.optional() }).strict().optional(),
  serialNo: z.string().trim().min(1).max(80).optional(),
  countedQty: quantity.refine((n) => n >= 0, "La cantidad contada no puede ser negativa"),
}).strict();

interface CountRow { id: string; number: string | null; status: string; stage: "open" | "applied"; warehouse_id: string; date: string }

async function lockCount(ctx: ProcessContext, countId: string): Promise<CountRow> {
  const [row] = await ctx.tx<CountRow[]>`select id, number, status, stage, warehouse_id, date::text as date from inventory.counts where id = ${countId} for update`;
  if (!row) throw new ProcessError("not_found", `count ${countId} not found`);
  return row;
}

/** Refuses a record / apply / void on a count that is already applied or voided. */
function requireOpen(count: CountRow): void {
  if (count.stage === "applied") refuse("count_already_applied", [`El conteo ${count.number ?? count.id} ya se aplicó`]);
  if (count.status === "voided") refuse("invalid_count_state", [`El conteo ${count.number ?? count.id} está anulado`]);
}

export const countCreate = defineProcess({
  id: "inventory.count.create",
  module: "inventory",
  kind: "create",
  feature: FEATURE,
  description: "Crea un conteo físico de una bodega con los productos (y ubicaciones) a contar; no mueve existencias; rechaza servicios y productos que no llevan existencias",
  input: countInput,
  output: createdOutput,
  handler: async (ctx, input) => {
    const warehouse = await warehouseOf(ctx, input.warehouseId);
    await refuseTransitWarehouse(ctx, warehouse.id);
    const products = await productFacts(ctx, input.lines.map((l) => l.productId));
    const locationIds = [...new Set(input.lines.flatMap((l) => (l.locationId ? [l.locationId] : [])))];
    const locations = locationIds.length === 0 ? [] : await ctx.tx<{ id: string; warehouse_id: string }[]>`
      select id, warehouse_id from inventory.locations where id = any(${locationIds}::uuid[]) and deleted_at is null`;
    const locationWarehouse = new Map(locations.map((l) => [l.id, l.warehouse_id]));
    const errors: string[] = [];
    const services: string[] = [];
    const seen = new Set<string>();
    const lines: { line: z.output<typeof countLineInput>; product: ProductFacts }[] = [];
    input.lines.forEach((line, i) => {
      const product = products.get(line.productId);
      if (!product) return errors.push(`Línea ${i + 1}: el producto no existe o no es visible`);
      if (product.kind === "service") return services.push(`Línea ${i + 1}: ${product.sku} es un servicio (kind=service): no mueve inventario`);
      if (!product.trackStock) return errors.push(`Línea ${i + 1}: ${product.sku} no lleva existencias`);
      if (line.locationId && locationWarehouse.get(line.locationId) !== warehouse.id) return errors.push(`Línea ${i + 1}: la ubicación no es de la bodega del conteo`);
      const key = `${line.productId}|${line.locationId ?? ""}`;
      if (seen.has(key)) return errors.push(`Línea ${i + 1}: ${product.sku} ya está en el conteo en esa ubicación`);
      seen.add(key);
      lines.push({ line, product });
    });
    if (services.length > 0) refuse("service_product_refused", services);
    if (errors.length > 0) refuse("invalid_count", errors);

    // A tracked product is counted per bucket: one line per lot or serial with stock at the ubicación (none yet: the counter adds what they find).
    const kinds = await trackingKinds(ctx, lines.map((l) => l.product.id));
    const buckets: { productId: string; locationId: string | null; lotId: string | null; serialId: string | null }[] = [];
    for (const { line, product } of lines) {
      const kind = kinds.get(product.id) ?? "none";
      if (kind === "none") {
        buckets.push({ productId: product.id, locationId: line.locationId ?? null, lotId: null, serialId: null });
        continue;
      }
      const held = await ctx.tx<{ lot_id: string | null; serial_id: string | null }[]>`
        select s.lot_id, s.serial_id from inventory.stock_levels s
        left join inventory.lots l on l.id = s.lot_id left join inventory.serials r on r.id = s.serial_id
        where s.company_id = ${ctx.companyId} and s.warehouse_id = ${warehouse.id} and s.product_id = ${product.id}
          and s.location_id is not distinct from ${line.locationId ?? null}::uuid and s.on_hand <> 0
          and ${kind === "lot" ? ctx.tx`s.lot_id is not null` : ctx.tx`s.serial_id is not null`}
        order by l.code nulls last, r.serial_no nulls last`;
      for (const b of held) buckets.push({ productId: product.id, locationId: line.locationId ?? null, lotId: b.lot_id, serialId: b.serial_id });
    }

    const [header] = await ctx.tx<{ id: string }[]>`
      insert into inventory.counts ${ctx.tx({
        company_id: ctx.companyId, date: input.date, warehouse_id: warehouse.id, description: input.description ?? null,
        // A conteo neither waits for approval nor posts itself: its adjustment does (ownFlags).
        requires_approval: false, posts: false,
      })}
      returning id`;
    const rows = buckets.length === 0 ? [] : await ctx.tx<{ id: string; line_no: number; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }[]>`
      insert into inventory.count_lines ${ctx.tx(buckets.map((b, i) => ({
        company_id: ctx.companyId, count_id: header!.id, line_no: i + 1, product_id: b.productId, location_id: b.locationId, lot_id: b.lotId, serial_id: b.serialId,
      })))}
      returning id, line_no, product_id, location_id, lot_id, serial_id`;
    const saved = await runLifecycle(ctx, ctx.registry.entity(countEntity.id), header!.id, "save");
    return {
      id: header!.id,
      number: saved.number ?? null,
      status: saved.status,
      lines: rows.map((r) => ({ id: r.id, lineNo: r.line_no, productId: r.product_id, locationId: r.location_id, lotId: r.lot_id, serialId: r.serial_id })).sort((a, b) => a.lineNo - b.lineNo),
    };
  },
});

export const countRecord = defineProcess({
  id: "inventory.count.record",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  description: "Registra las cantidades contadas de las líneas de un conteo abierto junto con lo que el sistema tenía en ese momento; no mueve existencias",
  input: z.object({
    id,
    lines: z.array(z.object({ lineId: id, countedQty: quantity.refine((n) => n >= 0, "La cantidad contada no puede ser negativa") }).strict()).max(1000).default([]),
    /** What the counter found that the sheet does not list: each becomes a line of its own (Task 28.2). */
    found: z.array(foundInput).max(1000).optional(),
  }).strict().refine((v) => v.lines.length + (v.found?.length ?? 0) > 0, "Registra al menos una línea"),
  output: z.object({ id: z.string(), recorded: z.number().int() }),
  handler: async (ctx, { id: countId, lines: given, found = [] }) => {
    const count = await lockCount(ctx, countId);
    requireOpen(count);
    const own = await ctx.tx<{ id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }[]>`
      select id, product_id, location_id, lot_id, serial_id from inventory.count_lines where count_id = ${countId}`;
    const byId = new Map(own.map((l) => [l.id, l]));
    const unknown = given.filter((l) => !byId.has(l.lineId));
    if (unknown.length > 0) refuse("invalid_count", unknown.map((l) => `La línea ${l.lineId} no es de este conteo`));
    if (new Set(given.map((l) => l.lineId)).size !== given.length) refuse("invalid_count", ["Una línea aparece dos veces"]);
    const lines = [...given, ...(await addFound(ctx, count, own, found))];
    const all = new Map((await ctx.tx<{ id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }[]>`
      select id, product_id, location_id, lot_id, serial_id from inventory.count_lines where count_id = ${countId}`).map((l) => [l.id, l]));
    for (const l of lines) {
      const line = all.get(l.lineId)!;
      // What the system holds in exactly this bucket now (the bodega's own stock when the line names no ubicación).
      const [held] = await ctx.tx<{ on_hand: string }[]>`
        select coalesce(sum(on_hand), 0)::text as on_hand from inventory.stock_levels
        where company_id = ${ctx.companyId} and warehouse_id = ${count.warehouse_id} and product_id = ${line.product_id}
          and location_id is not distinct from ${line.location_id}::uuid
          and lot_id is not distinct from ${line.lot_id}::uuid and serial_id is not distinct from ${line.serial_id}::uuid`;
      const system = num(held!.on_hand);
      await ctx.tx`
        update inventory.count_lines
        set system_qty = ${String(system)}::numeric, counted_qty = ${String(l.countedQty)}::numeric,
            difference = ${String(l.countedQty)}::numeric - ${String(system)}::numeric, recorded_at = now()
        where id = ${l.lineId}`;
    }
    return { id: countId, recorded: lines.length };
  },
});

export const countApply = defineProcess({
  id: "inventory.count.apply",
  module: "inventory",
  kind: "update",
  sensitivity: "step-up",
  feature: FEATURE,
  emits: [MOVEMENT_POSTED],
  description:
    "Aplica un conteo: registra sus diferencias (contado menos sistema) como un solo ajuste de inventario y lo cierra; requiere verificación reforzada y que todas las líneas estén contadas; un conteo aplicado no se vuelve a aplicar",
  input: z.object({ id, reason: z.string().trim().min(3).max(500).optional(), costCenterId: id.optional() }).strict(),
  output: z.object({ id: z.string(), stage: z.literal("applied"), adjustmentId: z.string().nullable(), adjustmentNumber: z.string().nullable() }),
  handler: async (ctx, { id: countId, reason, costCenterId }) => {
    // The count row serializes two applies: the second reads the stage the first left.
    const count = await lockCount(ctx, countId);
    requireOpen(count);
    const lines = await ctx.tx<{ id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; counted_qty: string | null; difference: string | null }[]>`
      select id, product_id, location_id, lot_id, serial_id, counted_qty::text, difference::text from inventory.count_lines where count_id = ${countId} order by line_no`;
    const pending = lines.filter((l) => l.counted_qty === null);
    if (pending.length > 0) refuse("count_incomplete", [`Faltan ${pending.length} línea(s) por contar`]);
    const differing = lines.filter((l) => num(l.difference) !== 0);

    let adjustmentId: string | null = null;
    let adjustmentNumber: string | null = null;
    if (differing.length > 0) {
      const posted = await postAdjustment(ctx, {
        // Dated the day it is applied, not the count's date: the stock changes now, and the count date may already sit in a closed period.
        date: await companyToday(ctx),
        warehouseId: count.warehouse_id,
        reason: reason ?? `Conteo físico ${count.number ?? count.id}`,
        reference: count.number ?? undefined,
        costCenterId,
        sourceEntity: countEntity.id,
        sourceId: countId,
        lines: differing.map((l) => ({
          productId: l.product_id, ...(l.location_id ? { locationId: l.location_id } : {}), qty: num(l.difference), sourceLineId: l.id,
          ...(l.lot_id ? { lotId: l.lot_id } : {}), ...(l.serial_id ? { serialIds: [l.serial_id] } : {}),
        })),
      });
      adjustmentId = savedMovementId(posted, "El ajuste del conteo");
      adjustmentNumber = posted.number;
    }
    await ctx.tx`update inventory.counts set stage = 'applied', applied_at = now(), adjustment_id = ${adjustmentId} where id = ${countId}`;
    return { id: countId, stage: "applied" as const, adjustmentId, adjustmentNumber };
  },
});

type CountLineRow = { id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null };

/**
 * Adds a line per bucket the counter found that the count does not list (Task 28.2) and returns their counted quantities. A lot named by a
 * new code is created nested (inventory.lot.create), a new serial number registered nested (inventory.serial.create, not in stock until
 * the count applies); a serial is found once (counted 1). A bucket already on the sheet is refused: its line is recorded instead.
 */
async function addFound(ctx: ProcessContext, count: CountRow, own: readonly CountLineRow[], found: readonly z.output<typeof foundInput>[]): Promise<{ lineId: string; countedQty: number }[]> {
  if (found.length === 0) return [];
  const products = await productFacts(ctx, found.map((f) => f.productId));
  const locationIds = [...new Set(found.flatMap((f) => (f.locationId ? [f.locationId] : [])))];
  const locations = locationIds.length === 0 ? [] : await ctx.tx<{ id: string; warehouse_id: string }[]>`
    select id, warehouse_id from inventory.locations where id = any(${locationIds}::uuid[]) and deleted_at is null`;
  const kinds = await trackingKinds(ctx, found.map((f) => f.productId));
  const errors: string[] = [];
  found.forEach((f, i) => {
    const product = products.get(f.productId);
    const at = `Encontrado ${i + 1}`;
    if (!product || product.kind === "service" || !product.trackStock) return errors.push(`${at}: el producto no existe o no lleva existencias`);
    if (f.locationId && locations.find((l) => l.id === f.locationId)?.warehouse_id !== count.warehouse_id) return errors.push(`${at}: la ubicación no es de la bodega del conteo`);
    const kind = kinds.get(product.id) ?? "none";
    if (kind === "none") return errors.push(`${at}: ${product.sku} no se sigue por lote ni por serial: agrégalo al conteo al crearlo`);
    if (kind === "serial" && f.countedQty !== 1) return errors.push(`${at}: un serial encontrado se cuenta 1`);
  });
  if (errors.length > 0) refuse("invalid_count", errors);
  // Resolved as inbound lines (a found bucket is stock the system does not list): new lots and serials are created nested; a serial the
  // system holds in stock elsewhere is refused serial_exists (move it with a traslado, or count it where the system has it).
  const resolved = await resolveTracked(ctx, found.map((f, i) => ({
    item: i,
    fields: { qty: 1, ...(f.lotId ? { lotId: f.lotId } : {}), ...(f.lot ? { lot: f.lot } : {}), ...(f.serialNo ? { serials: [{ serialNo: f.serialNo }] } : {}) },
    product: products.get(f.productId)!, index: i,
  })), "invalid_count", kinds);
  const keyOf = (b: { product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }) => `${b.product_id}|${b.location_id ?? ""}|${b.lot_id ?? ""}|${b.serial_id ?? ""}`;
  const taken = new Set(own.map(keyOf));
  const [last] = await ctx.tx<{ n: number }[]>`select coalesce(max(line_no), 0)::int as n from inventory.count_lines where count_id = ${count.id}`;
  const rows = resolved.map((r, n) => {
    const f = found[r.item]!;
    const row = { product_id: f.productId, location_id: f.locationId ?? null, lot_id: r.lotId, serial_id: r.serialId };
    if (taken.has(keyOf(row))) errors.push(`Encontrado ${r.item + 1}: ya está en el conteo: registra su línea`);
    taken.add(keyOf(row));
    return { company_id: ctx.companyId, count_id: count.id, line_no: last!.n + n + 1, ...row };
  });
  if (errors.length > 0) refuse("invalid_count", errors);
  const inserted = await ctx.tx<{ id: string; line_no: number }[]>`insert into inventory.count_lines ${ctx.tx(rows)} returning id, line_no`;
  const lineNo = new Map(inserted.map((r) => [r.line_no, r.id]));
  return rows.map((row, n) => ({ lineId: lineNo.get(row.line_no)!, countedQty: found[resolved[n]!.item]!.countedQty }));
}

export const countVoid = defineProcess({
  id: "inventory.count.void",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  description: "Anula un conteo abierto con el motivo; un conteo aplicado no se anula (su ajuste se corrige con otro ajuste)",
  input: z.object({ id, reason: z.string().trim().min(1, "Indica el motivo").max(1000), expectedUpdatedAt: z.iso.datetime({ offset: true }).optional() }),
  output: z.object({ id: z.string(), status: z.literal("voided"), number: z.string().optional(), updatedAt: z.string().optional() }),
  handler: async (ctx, { id: countId, reason, expectedUpdatedAt }) => {
    requireOpen(await lockCount(ctx, countId));
    const result = await runLifecycle(ctx, ctx.registry.entity(countEntity.id), countId, "void", { reason, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });
    return { id: countId, status: "voided" as const, ...(result.number ? { number: result.number } : {}), ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}) };
  },
});

export const countConsult = defineProcess({
  id: "inventory.count.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un conteo con sus líneas y los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: countId }) => {
    const [row] = await ctx.tx`select * from inventory.v_counts where id = ${countId}`;
    if (!row) throw new ProcessError("not_found", `count ${countId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from inventory.v_count_lines where count_id = ${countId} order by line_no`;
    return { ...row, id: countId, lines };
  },
});

export const countLineConsult = defineProcess({
  id: "inventory.count_line.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una línea de un conteo con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from inventory.v_count_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `count line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/** The hooks of a conteo: a saved one does not change through Grabar (record and apply move it), and the number is CT-. */
export const countHooks: TypedHooks = {
  async validate(_ctx, _record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (previous.status !== "draft" && data && Object.keys(data).length > 0) {
      refuse("invalid_count", ["Un conteo registrado no cambia: registra las cantidades contadas o anúlalo"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select inventory.next_movement_number(${ctx.companyId}, 'CT-') as number`;
    return row!.number;
  },
};

export const COUNT_PROCESSES = [countCreate, countRecord, countApply, countVoid, countConsult, countLineConsult];
