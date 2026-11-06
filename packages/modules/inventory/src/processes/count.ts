import { defineProcess, ProcessError, runLifecycle, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { countEntity } from "../entities";
import { postAdjustment } from "./adjustment";
import { id, idInput, num, productFacts, quantity, refuse, savedMovementId, type ProductFacts } from "./common";
import { companyToday, MOVEMENT_POSTED, refuseTransitWarehouse, warehouseOf } from "./movement";

// Conteos físicos (plan 2B Task 7, design §8.1). A conteo is a documento (numbered CT- on save, lines):
//   create → lists what to count in a bodega (product, and the ubicación when it is counted by ubicación);
//   record → stores, per line, what was counted and what the system held in that bucket at that moment; the difference is
//            counted − system (a line without ubicación is the bodega's own, unlocated stock, as in the movements);
//   apply  → STEP-UP: posts the non-zero differences as exactly ONE adjustment (sign = the difference's) and closes the count; a count
//            applied is final: re-applying and recording again are refused (`count_already_applied`), and two concurrent applies
//            queue on the count row so only the first posts. Source lines make the adjustment idempotent in the database as well.
// The difference is measured at record time, so movements after it are not undone by applying.

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
  lines: z.array(z.object({ id: z.string(), lineNo: z.number(), productId: z.string(), locationId: z.string().nullable() })),
});

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

    const [header] = await ctx.tx<{ id: string }[]>`
      insert into inventory.counts ${ctx.tx({
        company_id: ctx.companyId, date: input.date, warehouse_id: warehouse.id, description: input.description ?? null,
        // A conteo neither waits for approval nor posts itself: its adjustment does (ownFlags).
        requires_approval: false, posts: false,
      })}
      returning id`;
    const rows = await ctx.tx<{ id: string; line_no: number; product_id: string; location_id: string | null }[]>`
      insert into inventory.count_lines ${ctx.tx(lines.map(({ line }, i) => ({
        company_id: ctx.companyId, count_id: header!.id, line_no: i + 1, product_id: line.productId, location_id: line.locationId ?? null,
      })))}
      returning id, line_no, product_id, location_id`;
    const saved = await runLifecycle(ctx, ctx.registry.entity(countEntity.id), header!.id, "save");
    return {
      id: header!.id,
      number: saved.number ?? null,
      status: saved.status,
      lines: rows.map((r) => ({ id: r.id, lineNo: r.line_no, productId: r.product_id, locationId: r.location_id })).sort((a, b) => a.lineNo - b.lineNo),
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
    lines: z.array(z.object({ lineId: id, countedQty: quantity.refine((n) => n >= 0, "La cantidad contada no puede ser negativa") }).strict()).min(1).max(1000),
  }).strict(),
  output: z.object({ id: z.string(), recorded: z.number().int() }),
  handler: async (ctx, { id: countId, lines }) => {
    const count = await lockCount(ctx, countId);
    requireOpen(count);
    const own = await ctx.tx<{ id: string; product_id: string; location_id: string | null }[]>`
      select id, product_id, location_id from inventory.count_lines where count_id = ${countId}`;
    const byId = new Map(own.map((l) => [l.id, l]));
    const unknown = lines.filter((l) => !byId.has(l.lineId));
    if (unknown.length > 0) refuse("invalid_count", unknown.map((l) => `La línea ${l.lineId} no es de este conteo`));
    if (new Set(lines.map((l) => l.lineId)).size !== lines.length) refuse("invalid_count", ["Una línea aparece dos veces"]);
    for (const l of lines) {
      const line = byId.get(l.lineId)!;
      // What the system holds in exactly this bucket now (the bodega's own stock when the line names no ubicación).
      const [held] = await ctx.tx<{ on_hand: string }[]>`
        select coalesce(sum(on_hand), 0)::text as on_hand from inventory.stock_levels
        where company_id = ${ctx.companyId} and warehouse_id = ${count.warehouse_id} and product_id = ${line.product_id}
          and location_id is not distinct from ${line.location_id}::uuid and lot_id is null and serial_id is null`;
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
    const lines = await ctx.tx<{ id: string; product_id: string; location_id: string | null; counted_qty: string | null; difference: string | null }[]>`
      select id, product_id, location_id, counted_qty::text, difference::text from inventory.count_lines where count_id = ${countId} order by line_no`;
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
        lines: differing.map((l) => ({ productId: l.product_id, ...(l.location_id ? { locationId: l.location_id } : {}), qty: num(l.difference), sourceLineId: l.id })),
      });
      adjustmentId = savedMovementId(posted, "El ajuste del conteo");
      adjustmentNumber = posted.number;
    }
    await ctx.tx`update inventory.counts set stage = 'applied', applied_at = now(), adjustment_id = ${adjustmentId} where id = ${countId}`;
    return { id: countId, stage: "applied" as const, adjustmentId, adjustmentNumber };
  },
});

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
