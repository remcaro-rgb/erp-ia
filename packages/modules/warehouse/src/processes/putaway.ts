import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { enabledSince, id, num, qtyText, quantity, refuse, round4 } from "./common";

// Put-away (plan 2B.2 Task 29.3, PG §4.3 step 8; owner item 155; RG-10). The Reglas de ubicación say, per bodega, where the goods of a
// category (or any goods) go, the lowest priority first. warehouse.putaway.suggest lists, for a receipt (an inventory movement of kind
// receipt), where each of its lines still in the ubicación it was received in should go: a lot already shelved in the bodega goes with it
// (a lot stays together), else the first rule of the product's category, else the first rule for any goods. The user confirms
// (warehouse.putaway.confirm), which emits warehouse.putaway.confirmed; inventory relocates the stock (inventory.relocation.post, movement
// kind relocation: no cost). Warehouse reads inventory's published views (v_movements, v_movement_lines, v_stock_levels, v_locations,
// v_warehouses) and core's (v_product_stock, v_product_categories), never their tables, and never writes them (rule 3).
// The warehouse consumer of inventory.movement.posted (consumers.ts) runs warehouse.putaway.notify for each receipt: when the receipt has a
// line to put away, the kernel recommendation «Entrada por ubicar» is raised for whoever may confirm a put-away; confirming closes it.
// RG-10 (item 164): a receipt posted before the module started for the company (enabledSince) is not listed and raises nothing, so buying
// the module (which replays the parked events) does not ask to put away old receipts.

const FEATURE = "warehouse.putaway";
export const PUTAWAY_CONFIRMED = "warehouse.putaway.confirmed";
/** The recommendation's reason (kernel.recommendations, about the receipt: inventory.movement). */
const PUTAWAY_PENDING = "putaway_pending";
const RECEIPT_ENTITY = "inventory.movement";

// -------------------------------------------------------------------------------------------------
// Reglas de ubicación
// -------------------------------------------------------------------------------------------------

const priority = z.number().int().min(0).max(9999);
const ruleOutput = z.object({ id: z.string(), warehouseId: z.string(), categoryId: z.string().nullable(), locationId: z.string(), priority: z.number() });
interface RuleRow { id: string; warehouse_id: string; category_id: string | null; location_id: string; priority: number }
const asOutput = (r: RuleRow) => ({ id: r.id, warehouseId: r.warehouse_id, categoryId: r.category_id, locationId: r.location_id, priority: r.priority });

/** Refuses a rule whose bodega, ubicación (a storage ubicación of that bodega) or category does not exist for the caller. */
async function assertRule(ctx: ProcessContext, rule: { warehouseId: string; categoryId: string | null; locationId: string }): Promise<void> {
  const [warehouse] = await ctx.tx`select 1 from inventory.v_warehouses where id = ${rule.warehouseId}`;
  if (!warehouse) refuse("invalid_warehouse", ["La bodega no existe"]);
  const [location] = await ctx.tx<{ warehouse_id: string | null; kind: string | null }[]>`select warehouse_id, kind from inventory.v_locations where id = ${rule.locationId}`;
  if (!location || location.warehouse_id !== rule.warehouseId || location.kind !== "storage") {
    refuse("invalid_location", ["La ubicación no es de la bodega de la regla o es de tránsito"]);
  }
  if (rule.categoryId) {
    const [category] = await ctx.tx`select 1 from core.v_product_categories where id = ${rule.categoryId}`;
    if (!category) refuse("invalid_category", ["La categoría no existe"]);
  }
}

/** Writes a rule, turning the unique index's refusal into `rule_exists`. */
async function writeRule(ctx: ProcessContext, write: () => Promise<RuleRow[]>): Promise<RuleRow> {
  try {
    const [row] = await write();
    return row!;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") refuse("rule_exists", ["Ya hay una regla de esa bodega y categoría para esa ubicación"]);
    throw error;
  }
}

const RULE_COLUMNS = "id, warehouse_id, category_id, location_id, priority";

export const putawayRuleCreate = defineProcess({
  id: "warehouse.putaway_rule.create",
  module: "warehouse",
  kind: "create",
  feature: FEATURE,
  description:
    "Crea una regla de ubicación: en una bodega, los productos de una categoría (o cualquier producto, sin categoría) se ubican en una ubicación; gana la prioridad más baja",
  input: z.object({ warehouseId: id, categoryId: id.nullable().optional(), locationId: id, priority }).strict(),
  output: ruleOutput,
  handler: async (ctx, input) => {
    const rule = { warehouseId: input.warehouseId, categoryId: input.categoryId ?? null, locationId: input.locationId };
    await assertRule(ctx, rule);
    const row = await writeRule(ctx, () => ctx.tx<RuleRow[]>`
      insert into warehouse.putaway_rules ${ctx.tx({ company_id: ctx.companyId, warehouse_id: rule.warehouseId, category_id: rule.categoryId, location_id: rule.locationId, priority: input.priority })}
      returning ${ctx.tx.unsafe(RULE_COLUMNS)}`);
    return asOutput(row);
  },
});

export const putawayRuleUpdate = defineProcess({
  id: "warehouse.putaway_rule.update",
  module: "warehouse",
  kind: "update",
  // A regla de ubicación is a parámetro (no record page, no record guard), as the Parámetros de bodega.
  recordAccess: "none",
  feature: FEATURE,
  description: "Cambia la categoría, la ubicación o la prioridad de una regla de ubicación (la bodega no cambia)",
  input: z.object({ id, categoryId: id.nullable().optional(), locationId: id.optional(), priority: priority.optional() }).strict(),
  output: ruleOutput,
  handler: async (ctx, input) => {
    const [current] = await ctx.tx<RuleRow[]>`select ${ctx.tx.unsafe(RULE_COLUMNS)} from warehouse.putaway_rules where id = ${input.id} for update`;
    if (!current) throw new ProcessError("not_found", `putaway rule ${input.id} not found`);
    const next = {
      warehouseId: current.warehouse_id,
      categoryId: input.categoryId === undefined ? current.category_id : input.categoryId,
      locationId: input.locationId ?? current.location_id,
    };
    await assertRule(ctx, next);
    const row = await writeRule(ctx, () => ctx.tx<RuleRow[]>`
      update warehouse.putaway_rules set ${ctx.tx({ category_id: next.categoryId, location_id: next.locationId, priority: input.priority ?? current.priority })}
      where id = ${current.id} returning ${ctx.tx.unsafe(RULE_COLUMNS)}`);
    return asOutput(row);
  },
});

export const putawayRuleDelete = defineProcess({
  id: "warehouse.putaway_rule.delete",
  module: "warehouse",
  kind: "delete",
  // A regla de ubicación is a parámetro (no record page, no record guard), as the Parámetros de bodega.
  recordAccess: "none",
  feature: FEATURE,
  description: "Elimina una regla de ubicación (las existencias no se mueven)",
  input: z.object({ id }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const rows = await ctx.tx<{ id: string }[]>`delete from warehouse.putaway_rules where id = ${input.id} returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `putaway rule ${input.id} not found`);
    return { id: rows[0]!.id };
  },
});

export const putawayRuleConsult = defineProcess({
  id: "warehouse.putaway_rule.consult",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una regla de ubicación con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: ruleId }) => {
    const [row] = await ctx.tx<Record<string, unknown>[]>`select * from warehouse.v_putaway_rules where id = ${ruleId}`;
    if (!row) throw new ProcessError("not_found", `putaway rule ${ruleId} not found`);
    return { ...row, id: ruleId };
  },
});

// -------------------------------------------------------------------------------------------------
// Sugerir
// -------------------------------------------------------------------------------------------------

/** Why a line goes where it is suggested: with its lot, by the category's rule, by the rule for any goods, or nowhere (no rule). */
export const PUTAWAY_BASES = ["lot_together", "rule_category", "rule_any", "no_rule"] as const;

const suggestedLine = z.object({
  movementLineId: z.string(), productId: z.string(), lotId: z.string().nullable(), serialId: z.string().nullable(), qty: z.number(),
  fromLocationId: z.string().nullable(), toLocationId: z.string().nullable(), basis: z.enum(PUTAWAY_BASES),
});
const suggestOutput = z.object({
  movementId: z.string(),
  number: z.string().nullable(),
  warehouseId: z.string().nullable(),
  /** false: the receipt is not listed (RG-10: posted before the module started for the company). */
  listed: z.boolean(),
  reason: z.enum(["before_enabled"]).optional(),
  lines: z.array(suggestedLine),
});
type Suggestion = z.output<typeof suggestOutput>;

interface ReceiptRow { id: string; number: string | null; kind: string | null; status: string | null; warehouse_id: string | null; applied_at: Date | null }

/** The receipt as inventory publishes it, or a refusal: not found, or not a receipt still in the stock (`not_a_receipt`). */
async function receiptOf(ctx: ProcessContext, movementId: string): Promise<ReceiptRow & { warehouse_id: string }> {
  const [row] = await ctx.tx<ReceiptRow[]>`select id, number, kind, status, warehouse_id, applied_at from inventory.v_movements where id = ${movementId}`;
  if (!row) throw new ProcessError("not_found", `movement ${movementId} not found`);
  if (row.kind !== "receipt" || row.status === "voided" || !row.warehouse_id) refuse("not_a_receipt", [`El movimiento ${row.number ?? row.id} no es una entrada vigente`]);
  return row as ReceiptRow & { warehouse_id: string };
}

/**
 * The put-away of a receipt (see the file header). Per receipt line, what is still in the ubicación it was received in (the bucket's stock,
 * shared by the lines of one bucket in line order), and where it goes: the ubicación of the bodega (other than that one) holding most of the
 * same lot, else the first rule of the product's category, else the first rule without category, by priority then rule number. A line
 * already where its rule says, or with nothing left to move, is not listed; a line no rule covers is listed without destination.
 */
export async function suggestFor(ctx: ProcessContext, movementId: string): Promise<Suggestion> {
  const receipt = await receiptOf(ctx, movementId);
  const base = { movementId: receipt.id, number: receipt.number, warehouseId: receipt.warehouse_id };
  const since = await enabledSince(ctx);
  if (since && receipt.applied_at && receipt.applied_at.getTime() < since.getTime()) return { ...base, listed: false, reason: "before_enabled", lines: [] };

  const lines = await ctx.tx<{ id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; qty: string }[]>`
    select id, product_id, location_id, lot_id, serial_id, qty::text from inventory.v_movement_lines where movement_id = ${receipt.id} and qty > 0 order by line_no`;
  if (lines.length === 0) return { ...base, listed: true, lines: [] };
  const products = [...new Set(lines.map((l) => l.product_id))];
  const categories = new Map((await ctx.tx<{ id: string; category_id: string | null }[]>`
    select id, category_id from core.v_product_stock where id = any(${products}::uuid[])`).map((p) => [p.id, p.category_id]));
  const rules = await ctx.tx<{ category_id: string | null; location_id: string }[]>`
    select r.category_id, r.location_id from warehouse.putaway_rules r
    join inventory.v_locations l on l.id = r.location_id and l.warehouse_id = r.warehouse_id and l.kind = 'storage'
    where r.company_id = ${ctx.companyId} and r.warehouse_id = ${receipt.warehouse_id}
    order by r.priority, r.seq`;
  // The stock of the products in the bodega's storage ubicaciones, per bucket (what is still where it was received, and where each lot sits).
  const stock = await ctx.tx<{ product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; on_hand: string }[]>`
    select s.product_id, s.location_id, s.lot_id, s.serial_id, s.on_hand::text
    from inventory.v_stock_levels s left join inventory.v_locations l on l.id = s.location_id
    where s.warehouse_id = ${receipt.warehouse_id} and s.product_id = any(${products}::uuid[]) and s.on_hand > 0
      and (s.location_id is null or l.kind = 'storage')`;
  const key = (r: { product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null }) => `${r.product_id}|${r.location_id ?? ""}|${r.lot_id ?? ""}|${r.serial_id ?? ""}`;
  const left = new Map<string, number>();
  for (const s of stock) left.set(key(s), round4((left.get(key(s)) ?? 0) + num(s.on_hand)));

  const out: Suggestion["lines"] = [];
  for (const line of lines) {
    const k = key(line);
    const qty = round4(Math.min(num(line.qty), left.get(k) ?? 0));
    if (qty <= 0) continue;
    left.set(k, round4((left.get(k) ?? 0) - qty));
    let toLocationId: string | null = null;
    let basis: (typeof PUTAWAY_BASES)[number] = "no_rule";
    if (line.lot_id) {
      // A lot stays together: the storage ubicación of the bodega (not this line's) holding most of the lot.
      const shelved = stock
        .filter((s) => s.product_id === line.product_id && s.lot_id === line.lot_id && s.location_id && s.location_id !== line.location_id)
        .sort((x, y) => num(y.on_hand) - num(x.on_hand) || String(x.location_id).localeCompare(String(y.location_id)))[0];
      if (shelved) {
        toLocationId = shelved.location_id;
        basis = "lot_together";
      }
    }
    if (!toLocationId) {
      const category = categories.get(line.product_id) ?? null;
      const byCategory = category ? rules.find((r) => r.category_id === category) : undefined;
      const anyGoods = rules.find((r) => r.category_id === null);
      const rule = byCategory ?? anyGoods;
      if (rule) {
        toLocationId = rule.location_id;
        basis = byCategory ? "rule_category" : "rule_any";
      }
    }
    // Already where it should be: nothing to put away.
    if (toLocationId && toLocationId === line.location_id) continue;
    out.push({ movementLineId: line.id, productId: line.product_id, lotId: line.lot_id, serialId: line.serial_id, qty, fromLocationId: line.location_id, toLocationId, basis });
  }
  return { ...base, listed: true, lines: out };
}

export const putawaySuggest = defineProcess({
  id: "warehouse.putaway.suggest",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE,
  description:
    "Sugiere dónde ubicar lo recibido en una entrada: por línea, la ubicación donde ya está el mismo lote, o la de la regla de su categoría, o la regla general, por prioridad. No mueve existencias",
  input: z.object({ movementId: id }).strict(),
  output: suggestOutput,
  handler: async (ctx, { movementId }) => suggestFor(ctx, movementId),
});

// -------------------------------------------------------------------------------------------------
// Confirmar
// -------------------------------------------------------------------------------------------------

const confirmLine = z.object({
  productId: id,
  lotId: id.nullable().optional(),
  serialId: id.nullable().optional(),
  qty: quantity.refine((n) => n > 0, "La cantidad debe ser mayor que cero"),
  /** Where the stock is now: a ubicación of the receipt's bodega, or null for the bodega's own stock (no ubicación). */
  fromLocationId: id.nullable(),
  toLocationId: id,
}).strict();

export const putawayConfirm = defineProcess({
  id: "warehouse.putaway.confirm",
  module: "warehouse",
  kind: "update",
  // The receipt is inventory's; no record of warehouse is changed.
  recordAccess: "none",
  feature: FEATURE,
  emits: [PUTAWAY_CONFIRMED],
  description:
    "Confirma dónde se ubica lo recibido en una entrada: el inventario reubica las existencias entre ubicaciones de la misma bodega, con su lote y serial, sin cambiar el costo",
  input: z.object({ movementId: id, lines: z.array(confirmLine).min(1).max(250) }).strict(),
  output: z.object({ movementId: z.string(), lines: z.number().int() }),
  handler: async (ctx, input) => {
    const receipt = await receiptOf(ctx, input.movementId);
    const received = new Set((await ctx.tx<{ product_id: string }[]>`
      select distinct product_id from inventory.v_movement_lines where movement_id = ${receipt.id}`).map((r) => r.product_id));
    const locationIds = [...new Set(input.lines.flatMap((l) => [l.toLocationId, ...(l.fromLocationId ? [l.fromLocationId] : [])]))];
    const locations = new Map((await ctx.tx<{ id: string; warehouse_id: string | null; kind: string | null }[]>`
      select id, warehouse_id, kind from inventory.v_locations where id = any(${locationIds}::uuid[])`).map((l) => [l.id, l]));
    const problems = new Map<string, string[]>();
    const add = (code: string, text: string) => problems.set(code, [...(problems.get(code) ?? []), text]);
    input.lines.forEach((l, i) => {
      const at = `Línea ${i + 1}`;
      if (!received.has(l.productId)) add("putaway_not_on_receipt", `${at}: el producto no está en la entrada ${receipt.number ?? receipt.id}`);
      for (const locationId of [l.fromLocationId, l.toLocationId]) {
        if (!locationId) continue;
        const loc = locations.get(locationId);
        if (!loc) add("invalid_location", `${at}: la ubicación no existe`);
        else if (loc.warehouse_id !== receipt.warehouse_id) add("relocation_cross_warehouse", `${at}: la ubicación es de otra bodega; entre bodegas se mueve con un traslado`);
        else if (loc.kind !== "storage") add("invalid_location", `${at}: la ubicación de tránsito solo la usan los traslados`);
      }
      if (l.fromLocationId === l.toLocationId) add("invalid_location", `${at}: la ubicación de origen y la de destino son la misma`);
    });
    for (const code of ["relocation_cross_warehouse", ...problems.keys()]) if (problems.has(code)) refuse(code, problems.get(code)!);

    // What sits where the stock is taken from (inventory's published stock), per bucket: a put-away moves what is there.
    const want = new Map<string, { qty: number; line: z.output<typeof confirmLine>; index: number }>();
    input.lines.forEach((l, index) => {
      const k = `${l.productId}|${l.fromLocationId ?? ""}|${l.lotId ?? ""}|${l.serialId ?? ""}`;
      const seen = want.get(k);
      want.set(k, { qty: round4((seen?.qty ?? 0) + l.qty), line: l, index: seen?.index ?? index });
    });
    const stock = await ctx.tx<{ product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; on_hand: string }[]>`
      select product_id, location_id, lot_id, serial_id, on_hand::text from inventory.v_stock_levels
      where warehouse_id = ${receipt.warehouse_id} and product_id = any(${[...new Set(input.lines.map((l) => l.productId))]}::uuid[])`;
    const onHand = new Map(stock.map((s) => [`${s.product_id}|${s.location_id ?? ""}|${s.lot_id ?? ""}|${s.serial_id ?? ""}`, num(s.on_hand)]));
    const short = [...want].filter(([k, w]) => w.qty > (onHand.get(k) ?? 0));
    if (short.length > 0) {
      refuse("putaway_exceeds_stock", short.map(([k, w]) => `Línea ${w.index + 1}: en la ubicación de origen hay ${qtyText(onHand.get(k) ?? 0)} y se ubican ${qtyText(w.qty)}`));
    }

    await ctx.emit(PUTAWAY_CONFIRMED, {
      movementId: receipt.id,
      number: receipt.number,
      warehouseId: receipt.warehouse_id,
      lines: input.lines.map((l) => ({
        productId: l.productId, lotId: l.lotId ?? null, serialId: l.serialId ?? null, qty: l.qty, fromLocationId: l.fromLocationId, toLocationId: l.toLocationId,
      })),
    });
    // The «por ubicar» recommendation of the receipt: its cause is handled.
    await ctx.recommendations?.close({ subject: { entity: RECEIPT_ENTITY, id: receipt.id }, reason: PUTAWAY_PENDING });
    return { movementId: receipt.id, lines: input.lines.length };
  },
});

// -------------------------------------------------------------------------------------------------
// Avisar (consumer of inventory.movement.posted)
// -------------------------------------------------------------------------------------------------

/** Who is told a receipt is waiting to be put away: whoever may confirm a put-away. */
const PUTAWAY_AUDIENCE = "warehouse.putaway.confirm";

export const putawayNotify = defineProcess({
  id: "warehouse.putaway.notify",
  module: "warehouse",
  kind: "update",
  // The receipt is inventory's; the run writes only the kernel recommendation about it.
  recordAccess: "none",
  feature: FEATURE,
  origins: ["event"],
  description:
    "Avisa que una entrada tiene mercancía por ubicar según las reglas de ubicación (una recomendación para quien confirma ubicaciones); solo lo ejecuta el evento del movimiento",
  idempotencyKey: (input) => `putaway_notify:${input.eventId}`,
  input: z.object({ movementId: id, eventId: id }).strict(),
  output: z.object({ raised: z.boolean(), reason: z.enum(["before_enabled", "nothing_to_put_away"]).optional() }),
  handler: async (ctx, { movementId }) => {
    const suggestion = await suggestFor(ctx, movementId);
    if (!suggestion.listed) return { raised: false, reason: "before_enabled" as const };
    const pending = suggestion.lines.filter((l) => l.toLocationId !== null);
    if (pending.length === 0) return { raised: false, reason: "nothing_to_put_away" as const };
    const [warehouse] = await ctx.tx<{ name: string | null }[]>`select name from inventory.v_warehouses where id = ${suggestion.warehouseId}`;
    await ctx.recommendations?.raise({
      audienceProcess: PUTAWAY_AUDIENCE,
      subject: { entity: RECEIPT_ENTITY, id: movementId },
      reason: PUTAWAY_PENDING,
      titleKey: "warehouse.recommendation.putaway_pending.title",
      bodyKey: "warehouse.recommendation.putaway_pending.body",
      params: {
        number: { value: suggestion.number?.slice(0, 200) ?? null, entity: RECEIPT_ENTITY, field: "number" },
        warehouse: { value: warehouse?.name?.slice(0, 200) ?? null, entity: "inventory.warehouse", field: "name" },
        count: { value: pending.length },
      },
    });
    return { raised: true };
  },
});

export const PUTAWAY_PROCESSES = [putawayRuleCreate, putawayRuleUpdate, putawayRuleDelete, putawayRuleConsult, putawaySuggest, putawayConfirm, putawayNotify];
