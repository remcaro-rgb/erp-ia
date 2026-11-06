import { defineProcess, dismissParkedEvents, ProcessError, type EventConsumer, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { CostError, reverse } from "../average";
import type { EventKind } from "../entities";
import { feedLockKey } from "./common";
import { catchUp, COGS_POSTED, COGS_RETURNED, currencyOf, Layers } from "./cost";

// The cost of a voided inventory movement (plan 2B Task 14, the voids carried from the reviews of Tasks 6–9; design §8.1).
//
// costing.movement.void_cost consumes inventory.movement.voided for EVERY void (a receipt, an issue, a sale issue, a sale return), as the
// system user (origin event), under the company's feed lock:
//  1. it catches the feed up through the voided movement (a movement voided before costing valued it is still in the feed, as posted:
//     it is valued first, so the void always has its cost events to take back, and the order of the outbox never matters);
//  2. for each cost event of the movement (not its landed costs: a receipt with an active landed cost cannot be voided, inventory refuses
//     `landed_costs_active`; a voided landed cost already took its share back), it writes the exact opposite (kind and cost source
//     `reversal`, the same unit cost, the signed qty and amount negated, dated the void) and moves the layer by it (average.ts reverse):
//     the layer's value stays the sum of its events' amounts. A sale return voided takes out its units at the original issue's cost it
//     entered with;
//  3. the cost_missing occurrences it counted are taken back (the last one resolves the row: nothing is missing any more);
//  4. a sale issue (sale return) whose cost of sales already left (cogs_posted_at) sends costing.cogs.voided (costing.cogs.return_voided):
//     the rule `reverseOf` reverses the ledger entry of that cost of sales (and dismisses its pending when it could not post: a closed
//     period); any of its cost-of-sales events still parked in the outbox (accounting off) is dismissed so it never posts. A sale issue
//     voided before its own event ran sends nothing: its COGS never leaves (emitCogs skips a reversed movement).
// A redelivered void finds the reversal written and changes nothing.

const FEATURE = "costing.costs";
export const COGS_VOIDED = "costing.cogs.voided";
export const COGS_RETURN_VOIDED = "costing.cogs.return_voided";

const id = z.uuid();

/** The payload of costing.cogs.voided / costing.cogs.return_voided: the movement whose cost of sales is reversed. */
export interface CogsVoidEvent {
  movementId: string;
  cogsId: string;
  number: string;
  date: string;
  reason: string;
}

interface EventRow {
  id: string; kind: EventKind; movement_line_id: string; movement_seq: string; movement_number: string | null; product_id: string; category_id: string | null;
  warehouse_id: string; layer_id: string; qty: string; unit_cost: string; amount: string; cost_missing: boolean; cogs_posted_at: Date | null;
  source_entity: string | null; source_id: string | null;
}

/** Takes back one occurrence (and its units) of the open cost_missing row of the product in the bodega; the last one resolves it. */
async function undoMissing(ctx: ProcessContext, movementId: string, productId: string, warehouseId: string, qty: number): Promise<void> {
  const [open] = await ctx.tx<{ id: string; occurrences: number }[]>`
    select id, occurrences from costing.cost_missing where company_id = ${ctx.companyId} and product_id = ${productId} and warehouse_id = ${warehouseId} and status = 'open' for update`;
  if (!open) return;
  if (open.occurrences <= 1) {
    await ctx.tx`update costing.cost_missing set status = 'resolved', resolved_at = now(), resolved_movement_id = ${movementId} where id = ${open.id}`;
    return;
  }
  await ctx.tx`
    update costing.cost_missing set occurrences = occurrences - 1, qty = greatest(qty - ${String(Math.abs(qty))}::numeric, 0) where id = ${open.id}`;
}

/**
 * The day `at` (default now) falls on in the company's time zone: a void at 19:30 in Bogotá on the last day of a month is that month's, even
 * though it is already the 1st in UTC (Task 14 review).
 */
export async function companyDate(ctx: ProcessContext, at?: Date): Promise<string> {
  const [row] = await ctx.tx<{ day: string }[]>`
    select (coalesce(${at ?? null}::timestamptz, now()) at time zone coalesce(timezone, 'America/Bogota'))::date::text as day
    from kernel.companies where id = ${ctx.companyId}`;
  return row!.day;
}

export const movementVoidCost = defineProcess({
  id: "costing.movement.void_cost",
  module: "costing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  emits: [COGS_VOIDED, COGS_RETURN_VOIDED],
  description:
    "Revierte el costo de un movimiento de inventario anulado con eventos de costo opuestos; si su costo de ventas ya se contabilizó, emite su anulación; solo lo ejecuta el evento de anulación del movimiento",
  input: z.object({
    movementId: id,
    reason: z.string().trim().min(1).max(1000).optional(),
    /** The day of the void in the company's time zone, as inventory recorded it (default: today in that time zone). */
    voidedOn: z.iso.date().optional(),
  }).strict(),
  output: z.object({ movementId: z.string(), reversed: z.number().int(), cogsVoided: z.boolean() }),
  // Only the consumer of inventory.movement.voided runs it (origin event).
  origins: ["event"],
  // No idempotency key: a redelivered void finds the reversal written and changes nothing.
  handler: async (ctx, { movementId, reason, voidedOn }) => {
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${feedLockKey(ctx.companyId)}, 0))`;
    await catchUp(ctx, movementId);
    const events = await ctx.tx<EventRow[]>`
      select id, kind, movement_line_id, movement_seq, movement_number, product_id, category_id, warehouse_id, layer_id, qty, unit_cost, amount,
             cost_missing, cogs_posted_at, source_entity, source_id
      from costing.cost_events where company_id = ${ctx.companyId} and movement_id = ${movementId}
      order by seq for update`;
    if (events.some((e) => e.kind === "reversal")) return { movementId, reversed: 0, cogsVoided: false };
    const own = events.filter((e) => e.kind !== "landed_cost");
    if (own.length === 0) return { movementId, reversed: 0, cogsVoided: false };

    const date = voidedOn ?? (await companyDate(ctx));
    const currency = await currencyOf(ctx);
    const layers = new Layers(ctx, currency);
    for (const e of own) {
      const layer = await layers.get(e.product_id, e.warehouse_id);
      let back: ReturnType<typeof reverse>;
      try {
        back = reverse(layer, Number(e.qty), Number(e.amount));
      } catch (error) {
        if (error instanceof CostError) throw new ProcessError("invalid_input", error.message);
        throw error;
      }
      await ctx.tx`
        insert into costing.cost_events ${ctx.tx({
          company_id: ctx.companyId,
          movement_id: movementId,
          // A reversal has no movement line of its own (the line it reverses is source_line_id): a fresh id keeps the key unique.
          movement_line_id: (await ctx.tx<{ id: string }[]>`select kernel.uuid_v7() as id`)[0]!.id,
          movement_seq: Number(e.movement_seq),
          movement_number: e.movement_number,
          kind: "reversal",
          date,
          product_id: e.product_id,
          category_id: e.category_id,
          warehouse_id: e.warehouse_id,
          layer_id: layer.id,
          qty: back.qty,
          unit_cost: Number(e.unit_cost),
          amount: back.amount,
          cost_source: "reversal",
          cost_missing: false,
          qty_after: back.after.qty,
          value_after: back.after.value,
          avg_after: back.after.avgCost,
          currency,
          exchange_rate: 1,
          source_entity: e.source_entity,
          source_id: e.source_id,
          source_line_id: e.movement_line_id,
        })}`;
      await layers.set(layer, back.after, { id: movementId, seq: Number(e.movement_seq) });
      if (e.cost_missing) await undoMissing(ctx, movementId, e.product_id, e.warehouse_id, Number(e.qty));
    }

    const kind = own[0]!.kind;
    let cogsVoided = false;
    if (kind === "sale_issue" || kind === "sale_return") {
      const posted = kind === "sale_issue" ? COGS_POSTED : COGS_RETURNED;
      // A cost of sales still parked (accounting off when it left) never posts now; one that posted (or waits as a pending) is reversed.
      await dismissParkedEvents(ctx, posted, { movementId });
      if (own.some((e) => e.cogs_posted_at !== null)) {
        const payload: CogsVoidEvent = { movementId, cogsId: movementId, number: own[0]!.movement_number ?? movementId, date, reason: reason ?? "Movimiento anulado" };
        await ctx.emit(kind === "sale_issue" ? COGS_VOIDED : COGS_RETURN_VOIDED, payload);
        cogsVoided = true;
      }
    }
    return { movementId, reversed: own.length, cogsVoided };
  },
});

/** The payload fields the consumer reads of inventory.movement.voided (inventory's MovementEvent). */
const movementVoided = z.looseObject({ movementId: id, voidedOn: z.iso.date().optional() });

/** Consumer of inventory.movement.voided: takes the movement's cost back out of its layers, as the system user, origin event. */
export const onMovementVoided: EventConsumer = async (ctx, payload) => {
  const parsed = movementVoided.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `inventory.movement.voided payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  // The void's reason is in the movement's audit; the cost events say `reversal`.
  await ctx.runProcess("costing.movement.void_cost", { movementId: parsed.data.movementId, ...(parsed.data.voidedOn ? { voidedOn: parsed.data.voidedOn } : {}) });
};

export const VOID_PROCESSES = [movementVoidCost];
