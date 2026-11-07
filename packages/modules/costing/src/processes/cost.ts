import { defineProcess, ProcessError, type EventConsumer, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { averageOf, CostError, enter, exit, round2, round4, type Layer } from "../average";
import type { CostSource, EventKind } from "../entities";
import { closeCostMissing, feedLockKey, raiseCostMissing } from "./common";

// Costing of the inventory movements (plan 2B Task 8, design §8.1, OD-5 weighted average only).
//
// costing.movement.cost values every inventory movement in the inventory's own order, the movement `seq` (gap-free per company, drawn under
// a lock held until the movement's transaction ends: once a movement is committed, every movement with a lower seq is committed too). The
// company's feed position (costing.feeds.next_seq) says which movement comes next. A delivered event values every movement from that
// position up to its own, read through inventory.movement_feed (migration 0074), under the company's feed lock: so an issue whose event
// arrives before its receipt's is valued after the receipt anyway (the receipt is pulled first), the result never depends on the order the
// outbox delivers the events in, and a late event finds its movement valued and changes nothing (one cost event per movement line, unique).
// The COGS of a sale issue leaves only in the run of the sale issue's OWN event (`costing.cogs.posted`, on that event's causal chain, with the
// cost center it carries); a sale issue valued while pulled by a later movement waits for it (cost_events.cogs_posted_at).
//
// Valuation, per line (average.ts does the arithmetic):
//  - receipt: the line's cost, else the layer's average, else the product's standard cost, else 0 (cost_missing);
//  - sale_return: the cost of the sale issue line it returns (`return_of_line_id`), else as a receipt;
//  - transfer_in: the cost of the traslado's out leg it follows;
//  - adjustment: the line's cost, which inventory set from this layer's average or the standard cost, so the ledger entry of the adjustment
//    and the layer move by the same value; no cost: 0 (cost_missing, the event says costMissing);
//  - issue, sale_issue, transfer_out: the layer's average; an empty layer is seeded with the standard cost; none: 0 (cost_missing).
// A missing cost never blocks anything and never touches invoice_ready (main §5.8b): the stock moved, the line is valued at 0 and one
// open costing.cost_missing row per product and bodega counts it until an entry with a cost resolves it.
// Uncosted units are deliberate policy: they enter at 0 and stay in the layer's quantity, so they dilute the average of later entries
// (10 @ 0 then 5 @ 200 → 15 units worth 1.000, average 66,67; with 3 issued in between, 12 worth 1.000 → 83,33). Nothing is invented for
// them; the cost_missing row tells who must fix the cost (an adjustment).
// The subledger reconciles: a layer's value is always the sum of its cost events' amounts (average.ts), which are what the ledger posts.
// The average is read as value / qty at read time (average.ts averageOf, costing.average_costs in 0075), so no rounding residue stays
// behind in the layer; avg_cost on the layer is a 4-decimal snapshot for display. Inventory reads costing.average_costs() without
// declaring costing (documented in the inventory manifest); it returns nothing for a company that switched costing off.
// Audit: movements pulled into another movement's run (an issue whose receipt's event is late) are written, and audited, on the PULLING
// run's chain; their own event later finds them valued. The COGS, which carries the causal chain to the ledger, always leaves on the sale
// issue's own chain.
// Concurrency: the company's feed lock serializes the runs; two deliveries at once queue, and the second finds the first's work done.
// Voids (inventory.movement.voided) are costed by costing.movement.void_cost (void.ts, Task 14): it catches the feed up through the voided
// movement and writes the opposite of each of its cost events.

const FEATURE = "costing.costs";
export const COGS_POSTED = "costing.cogs.posted";
/** The cost of sales of a sale return (Task 14): Dr inventory / Cr cogs, at the original issue's cost. */
export const COGS_RETURNED = "costing.cogs.returned";

const id = z.uuid();

/** One line of costing.cogs.posted: the brief's fields plus the 2A fixture's (`cost`, `costCenterId`) the rule `cogs-posted` reads. */
export interface CogsLine {
  lineId: string;
  productId: string;
  categoryId: string | null;
  warehouseId: string;
  qty: number;
  unitCost: number;
  amount: number;
  /** = amount: the field the 2A rule posts (Dr cogs / Cr inventory). */
  cost: number;
  costCenterId?: string;
}

/** The payload of costing.cogs.posted (plan 2B Task 8), a superset of the 2A fixture `cogs-posted` (cogsId, number, date, lines[].cost). */
export interface CogsEvent {
  /** The sale issue movement (kept from the 2A fixture; the rule's source is `movementId`, entity inventory.movement). */
  cogsId: string;
  /** The source of the ledger entry (inventory.movement, rule 21). */
  movementId: string;
  number: string;
  date: string;
  sourceRef: { entity: string; id: string } | null;
  costCenterId?: string;
  lines: CogsLine[];
}

export function cogsPayload(input: {
  movementId: string; number: string; date: string; sourceEntity: string | null; sourceId: string | null; costCenterId?: string;
  lines: Omit<CogsLine, "cost" | "costCenterId">[];
}): CogsEvent {
  return {
    cogsId: input.movementId,
    movementId: input.movementId,
    number: input.number,
    date: input.date,
    sourceRef: input.sourceEntity && input.sourceId ? { entity: input.sourceEntity, id: input.sourceId } : null,
    ...(input.costCenterId ? { costCenterId: input.costCenterId } : {}),
    lines: input.lines.map((l) => ({ ...l, cost: l.amount, ...(input.costCenterId ? { costCenterId: input.costCenterId } : {}) })),
  };
}

interface FeedRow {
  movement_id: string; seq: string; number: string | null; kind: EventKind; date: string; warehouse_id: string; source_entity: string | null;
  source_id: string | null; line_id: string; line_no: number; product_id: string; qty: string; unit_cost: string | null; source_line_id: string | null;
  return_of_line_id: string | null;
}
export interface FeedMovement { id: string; seq: number; number: string | null; kind: EventKind; date: string; warehouseId: string; sourceEntity: string | null; sourceId: string | null; lines: FeedRow[] }

export interface LayerRow extends Layer { id: string }

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** The run's view of the layers it touches: read once, written after every line. */
export class Layers {
  private readonly rows = new Map<string, LayerRow>();
  constructor(private readonly ctx: ProcessContext, private readonly currency: string) {}

  async get(productId: string, warehouseId: string): Promise<LayerRow> {
    const key = `${productId}|${warehouseId}`;
    const seen = this.rows.get(key);
    if (seen) return seen;
    const [row] = await this.ctx.tx<{ id: string; qty: string; value: string; avg_cost: string | null }[]>`
      select id, qty, value, avg_cost from costing.cost_layers
      where company_id = ${this.ctx.companyId} and product_id = ${productId} and warehouse_id = ${warehouseId} and method = 'average'
      for update`;
    const layer: LayerRow = row
      ? { id: row.id, qty: Number(row.qty), value: Number(row.value), avgCost: num(row.avg_cost) }
      : {
          // The feed lock serializes the company's costing runs, so a plain insert creates the layer once (no `on conflict`, no seq gap).
          id: (await this.ctx.tx<{ id: string }[]>`
            insert into costing.cost_layers ${this.ctx.tx({ company_id: this.ctx.companyId, product_id: productId, warehouse_id: warehouseId, method: "average", currency: this.currency })}
            returning id`)[0]!.id,
          qty: 0, value: 0, avgCost: null,
        };
    this.rows.set(key, layer);
    return layer;
  }

  async set(layer: LayerRow, after: Layer, movement: Pick<FeedMovement, "id" | "seq">): Promise<void> {
    Object.assign(layer, after);
    await this.ctx.tx`
      update costing.cost_layers set qty = ${String(after.qty)}::numeric, value = ${String(after.value)}::numeric,
        avg_cost = ${after.avgCost === null ? null : String(after.avgCost)}::numeric, last_movement_id = ${movement.id}, last_movement_seq = ${movement.seq}
      where id = ${layer.id}`;
  }
}

/** Raises (or counts on) the open cost_missing row of the product in the bodega, and its kernel recommendation (Task 38). */
async function raiseMissing(ctx: ProcessContext, movement: FeedMovement, productId: string, warehouseId: string, qty: number): Promise<void> {
  const [open] = await ctx.tx<{ id: string }[]>`
    select id from costing.cost_missing where company_id = ${ctx.companyId} and product_id = ${productId} and warehouse_id = ${warehouseId} and status = 'open' for update`;
  const [row] = open
    ? await ctx.tx<{ id: string; occurrences: number }[]>`
        update costing.cost_missing set occurrences = occurrences + 1, qty = qty + ${String(Math.abs(qty))}::numeric, last_movement_id = ${movement.id},
          last_date = greatest(last_date, ${movement.date}::date)
        where id = ${open.id} returning id, occurrences`
    : await ctx.tx<{ id: string; occurrences: number }[]>`
        insert into costing.cost_missing ${ctx.tx({
          company_id: ctx.companyId, product_id: productId, warehouse_id: warehouseId, qty: Math.abs(qty), first_movement_id: movement.id,
          last_movement_id: movement.id, first_date: movement.date, last_date: movement.date,
        })} returning id, occurrences`;
  await raiseCostMissing(ctx, { id: row!.id, productId, warehouseId, occurrences: row!.occurrences });
}

/** An entry that brings a cost resolves the product's open cost_missing row in the bodega, and closes its recommendation. */
async function resolveMissing(ctx: ProcessContext, movement: FeedMovement, productId: string, warehouseId: string): Promise<void> {
  const resolved = await ctx.tx<{ id: string }[]>`
    update costing.cost_missing set status = 'resolved', resolved_at = now(), resolved_movement_id = ${movement.id}
    where company_id = ${ctx.companyId} and product_id = ${productId} and warehouse_id = ${warehouseId} and status = 'open'
    returning id`;
  for (const r of resolved) await closeCostMissing(ctx, r.id);
}

/** Values the lines of one movement, in line order, writing their cost events, the layers and the cost_missing rows. */
async function valueMovement(ctx: ProcessContext, movement: FeedMovement, layers: Layers, facts: { categories: Map<string, string | null>; standard: Map<string, number> }, currency: string): Promise<void> {
  for (const line of movement.lines) {
    const qty = Number(line.qty);
    const lineCost = num(line.unit_cost);
    const layer = await layers.get(line.product_id, movement.warehouseId);
    const standard = facts.standard.get(line.product_id) ?? null;
    const current = averageOf(layer);
    const average = current !== null && current > 0 ? current : null;
    let unitCost: number;
    let amount: number;
    let source: CostSource;
    let after: Layer;

    if (qty > 0) {
      // An entry: find its cost.
      let found: { cost: number; source: CostSource } | null = null;
      if (movement.kind === "sale_return" && line.return_of_line_id) {
        const [original] = await ctx.tx<{ unit_cost: string }[]>`
          select unit_cost from costing.cost_events where company_id = ${ctx.companyId} and movement_line_id = ${line.return_of_line_id}`;
        if (original) found = { cost: Number(original.unit_cost), source: "original_issue" };
      }
      if (!found && movement.kind === "transfer_in" && movement.sourceId) {
        const [out] = await ctx.tx<{ unit_cost: string }[]>`
          select unit_cost from costing.cost_events
          where company_id = ${ctx.companyId} and source_id = ${movement.sourceId} and kind = 'transfer_out' and product_id = ${line.product_id}
            and movement_seq < ${movement.seq}
          order by movement_seq desc, seq limit 1`;
        if (out) found = { cost: Number(out.unit_cost), source: "transfer" };
      }
      if (!found && lineCost !== null) found = { cost: lineCost, source: "line" };
      if (!found && movement.kind !== "adjustment" && movement.kind !== "transfer_in") {
        if (average !== null) found = { cost: average, source: "average" };
        else if (standard !== null && standard > 0) found = { cost: standard, source: "standard" };
      }
      const entry = enter(layer, qty, found?.cost ?? 0);
      unitCost = round4(found?.cost ?? 0);
      amount = entry.amount;
      source = found && found.cost > 0 ? found.source : found?.source === "line" ? "line" : "none";
      after = entry.after;
    } else {
      // An exit: at the adjustment's own cost, else at the layer's average (an empty layer takes the standard cost as its first average).
      const given = movement.kind === "adjustment" && lineCost !== null ? lineCost : undefined;
      const seed = given === undefined && average === null && standard !== null && standard > 0 ? standard : undefined;
      const taken = exit(layer, -qty, given ?? seed);
      unitCost = taken.unitCost;
      amount = -taken.amount;
      source = given !== undefined ? "line" : seed !== undefined ? "standard" : average !== null ? "average" : "none";
      after = seed !== undefined ? { ...taken.after, avgCost: taken.after.avgCost ?? round4(seed) } : taken.after;
    }
    const missing = unitCost === 0;

    await ctx.tx`
      insert into costing.cost_events ${ctx.tx({
        company_id: ctx.companyId,
        movement_id: movement.id,
        movement_line_id: line.line_id,
        movement_seq: movement.seq,
        movement_number: movement.number,
        kind: movement.kind,
        date: movement.date,
        product_id: line.product_id,
        category_id: facts.categories.get(line.product_id) ?? null,
        warehouse_id: movement.warehouseId,
        layer_id: layer.id,
        qty,
        unit_cost: unitCost,
        amount: round2(amount),
        cost_source: source,
        cost_missing: missing,
        qty_after: after.qty,
        value_after: after.value,
        avg_after: after.avgCost,
        currency,
        exchange_rate: 1,
        source_entity: movement.sourceEntity,
        source_id: movement.sourceId,
        source_line_id: line.source_line_id,
        return_of_line_id: line.return_of_line_id,
      })}`;
    await layers.set(layer, after, movement);
    if (missing) await raiseMissing(ctx, movement, line.product_id, movement.warehouseId, qty);
    else if (qty > 0) await resolveMissing(ctx, movement, line.product_id, movement.warehouseId);
  }
}

const group = (rows: FeedRow[]): FeedMovement[] => {
  const out: FeedMovement[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.id === row.movement_id) {
      last.lines.push(row);
      continue;
    }
    out.push({
      id: row.movement_id, seq: Number(row.seq), number: row.number, kind: row.kind, date: row.date, warehouseId: row.warehouse_id,
      sourceEntity: row.source_entity, sourceId: row.source_id, lines: [row],
    });
  }
  return out;
};

/**
 * Emits the cost of sales of a sale issue (costing.cogs.posted) or of a sale return (costing.cogs.returned, Task 14: the returned units
 * at the original issue's cost back into inventory) whose cost events have not left yet (once: cogs_posted_at). A movement already
 * reversed (voided before its own event ran) sends nothing.
 */
async function emitCogs(ctx: ProcessContext, movementId: string, costCenterId: string | undefined): Promise<boolean> {
  const events = await ctx.tx<{ id: string; kind: EventKind; movement_line_id: string; movement_number: string | null; date: string; source_entity: string | null; source_id: string | null; product_id: string; category_id: string | null; warehouse_id: string; qty: string; unit_cost: string; amount: string; cogs_posted_at: Date | null }[]>`
    select e.id, e.kind, e.movement_line_id, e.movement_number, e.date::text as date, e.source_entity, e.source_id, e.product_id, e.category_id,
           e.warehouse_id, e.qty, e.unit_cost, e.amount, e.cogs_posted_at
    from costing.cost_events e where e.company_id = ${ctx.companyId} and e.movement_id = ${movementId}
    order by e.movement_seq, e.seq
    for update`;
  const kind = events[0]?.kind;
  if (kind !== "sale_issue" && kind !== "sale_return") return false;
  if (events.some((e) => e.kind === "reversal" || e.cogs_posted_at !== null)) return false;
  const own = events.filter((e) => e.kind === kind);
  const lines = own.map((e) => ({
    lineId: e.movement_line_id, productId: e.product_id, categoryId: e.category_id, warehouseId: e.warehouse_id,
    qty: Math.abs(Number(e.qty)), unitCost: Number(e.unit_cost), amount: Math.abs(Number(e.amount)),
  }));
  // Nothing to post (every line without a cost, flagged in cost_missing): an entry of 0 is not an entry.
  if (lines.every((l) => l.amount === 0)) return false;
  const head = own[0]!;
  await ctx.emit(kind === "sale_issue" ? COGS_POSTED : COGS_RETURNED, cogsPayload({
    movementId, number: head.movement_number ?? movementId, date: head.date, sourceEntity: head.source_entity, sourceId: head.source_id,
    ...(costCenterId ? { costCenterId } : {}), lines,
  }));
  await ctx.tx`update costing.cost_events set cogs_posted_at = now() where id = any(${own.map((e) => e.id)}::uuid[])`;
  return true;
}

/**
 * Values every movement of the company's feed up to `movementId` (under the feed lock the caller holds), in seq order; answers how many
 * it valued. not_found when the movement is neither in the feed nor valued; handler_failed (retried) on a hole in the seq.
 */
export async function catchUp(ctx: ProcessContext, movementId: string): Promise<number> {
  let [feed] = await ctx.tx<{ next_seq: string }[]>`select next_seq from costing.feeds where company_id = ${ctx.companyId} for update`;
  if (!feed) [feed] = await ctx.tx<{ next_seq: string }[]>`insert into costing.feeds (company_id) values (${ctx.companyId}) returning next_seq`;
  const from = Number(feed!.next_seq);
  const rows = await ctx.tx<FeedRow[]>`
    select movement_id, seq, number, kind, date::text as date, warehouse_id, source_entity, source_id, line_id, line_no, product_id, qty, unit_cost,
           source_line_id, return_of_line_id
    from inventory.movement_feed(${from - 1}, ${movementId})`;
  const movements = group(rows);
  if (movements.length === 0) {
    const [valued] = await ctx.tx`select 1 from costing.cost_events where company_id = ${ctx.companyId} and movement_id = ${movementId} limit 1`;
    if (!valued) throw new ProcessError("not_found", `inventory movement ${movementId} not found`);
    return 0;
  }
  let expected = from;
  for (const m of movements) {
    // The seq is gap-free: a hole means a movement not visible yet, so the run is retried (outbox backoff), never valued out of order.
    if (m.seq !== expected) throw new ProcessError("handler_failed", `costing feed: movement seq ${expected} is missing (found ${m.seq})`);
    expected += 1;
  }
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const currency = await currencyOf(ctx);
  const categories = new Map((await ctx.tx<{ id: string; category_id: string | null }[]>`
    select id, category_id from core.v_product_stock where id = any(${productIds}::uuid[])`).map((r) => [r.id, r.category_id] as const));
  const standard = new Map((await ctx.tx<{ id: string; standard_cost: string | null }[]>`
    select id, standard_cost from core.product_standard_costs(${productIds}::uuid[])`).flatMap((r) => (r.standard_cost === null ? [] : [[r.id, Number(r.standard_cost)] as const])));
  const layers = new Layers(ctx, currency);
  try {
    for (const m of movements) await valueMovement(ctx, m, layers, { categories, standard }, currency);
  } catch (error) {
    // A negative cost cannot be valued: refused for good (the outbox dead-letters it), never retried.
    if (error instanceof CostError) throw new ProcessError("invalid_input", error.message);
    throw error;
  }
  await ctx.tx`update costing.feeds set next_seq = ${expected}, updated_at = now() where company_id = ${ctx.companyId}`;
  return movements.length;
}

export async function currencyOf(ctx: ProcessContext): Promise<string> {
  const [company] = await ctx.tx<{ currency_code: string }[]>`select currency_code from kernel.companies where id = ${ctx.companyId}`;
  return company?.currency_code ?? "COP";
}

export const movementCost = defineProcess({
  id: "costing.movement.cost",
  module: "costing",
  kind: "create",
  feature: FEATURE,
  emits: [COGS_POSTED, COGS_RETURNED],
  description:
    "Valoriza los movimientos de inventario al costo promedio ponderado en el orden del inventario, hasta el movimiento indicado; registra los productos sin costo y, para una salida por venta, emite el costo de ventas; solo lo ejecuta el evento del movimiento",
  input: z.object({
    movementId: id,
    /** The cost center the sale issue's event carries (accounting's id, passed on to the COGS lines). */
    costCenterId: id.optional(),
  }).strict(),
  output: z.object({ movementId: z.string(), valued: z.number().int(), cogs: z.boolean() }),
  // Only the consumer of inventory.movement.posted runs it (origin event): no person or assistant values or sends a cost of sales.
  origins: ["event"],
  // No idempotency key: the run itself is idempotent (one cost event per movement line, the feed position, cogs_posted_at), so a
  // redelivered event runs again and changes nothing already done.
  handler: async (ctx, { movementId, costCenterId }) => {
    // One costing run per company at a time: the feed position, the layers and the cost_missing rows are written under this lock.
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${feedLockKey(ctx.companyId)}, 0))`;
    const valued = await catchUp(ctx, movementId);
    // The COGS leaves with the sale issue's own event (its chain, its cost center).
    const cogs = await emitCogs(ctx, movementId, costCenterId);
    return { movementId, valued, cogs };
  },
});

/** The payload fields the consumer reads of inventory.movement.posted (inventory's MovementEvent). */
const movementPosted = z.looseObject({
  movementId: id,
  costCenterId: id.optional(),
});

/** Consumer of inventory.movement.posted: values the movement (and the ones before it) as the system user, origin event. */
export const onMovementPosted: EventConsumer = async (ctx, payload) => {
  const parsed = movementPosted.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `inventory.movement.posted payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  await ctx.runProcess("costing.movement.cost", { movementId: parsed.data.movementId, ...(parsed.data.costCenterId ? { costCenterId: parsed.data.costCenterId } : {}) });
};

export const COST_PROCESSES = [movementCost];
