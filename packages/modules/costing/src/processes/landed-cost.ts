import { defineProcess, dismissParkedEvents, emitAndPostStrict, emitStatusChanged, ProcessError, runLifecycle, visibleExtra, writeSnapshot, type ProcessContext, type RecordStatus, type TypedHooks, type TypedRecord } from "@erp/kernel";
import { z } from "zod";
import { distribute, splitShare } from "../allocation";
import { revalue, round4, CostError, type Layer } from "../average";
import { LANDED_BASES, landedCostEntity, OFFSET_ROLES, type LandedBasis } from "../entities";
import { feedLockKey, refuse } from "./common";

// Landed costs (plan 2B Task 9, design §8.1, OD-5): costing.landed_cost.allocate takes an amount (freight, duties, insurance) paid for a
// receipt and spreads it over the receipt's lines by their value, quantity or weight, raising the value of their cost layers. It is a
// documento that posts (contabiliza): the action allocates, numbers the document (CD-n, on save) and posts it, in one transaction, so a
// landed cost never exists as a Borrador and a refusal leaves no trace. The ledger entry comes from the event costing.landed_cost.allocated
// through the default rules the costing manifest ships (Dr inventory per line / Cr the offset role the user names). The entry is posted
// INLINE and STRICT (entity types D8, controller ruling of Task 9): the post hook calls the kernel's emitAndPostStrict, which writes the
// event to the outbox and posts its rules in this very transaction through the posting provider. If the ledger refuses (a closed period,
// a tercero not ready, a missing cost center or account mapping, no rule) the whole action rolls back: no document, no cost event, the
// layers unchanged, no entry and no posting failure. The asynchronous accounting consumer later receives the same event and finds the
// entry already posted for it (entries are keyed by event and rule), so nothing posts twice. The event is also marked handled by the
// posting module (kernel.outbox_deliveries), so the consumer never recomposes it after a configuration change. A company without
// accounting enabled still allocates: the event parks in the outbox and accounting posts it when it is enabled; a ledger never started is
// refused (ledger_not_started); an allocation dated before the ledger start is skipped (counted), as the engine does.
//
// The allocation: the receipt's cost events (costing's own, so the receipt must have been valued) give each line's value, quantity and layer;
// weight has no field on the product (the DIAN data of main §5.8b carries none), so the request gives each line's total weight. The shares
// are whole cents by largest remainder (allocation.ts): the lines' shares add up to the amount to the cent.
// A cost that arrives after units of the receipt were sold (Task 45, item 37, rulings R45-1..R45-10; owner items 137-139, pending the
// accountant) sends the share of those units to cost of sales in the current period; nothing in a past period is rewritten:
//  - which units count as sold (R45-1, average costing: units are fungible): per receipt line, onHand = min(received, the layer's quantity
//    now), the newest receipt being assumed to be what is still on hand; lines of the same product share their layer, so its units on hand
//    are given to the lines in order, never twice. The share splits by units (splitShare): the stock part (share × onHand / received,
//    half-up to the cent) and the cost of sales part (the remainder): the two add up to the share exactly;
//  - the stock part goes to the layer's VALUE at once and the layer's quantity does not move, so the average of the units that remain rises
//    by stock part / qty; it is recorded as a cost event of kind `landed_cost` (qty 0), so a layer's value is still the sum of its events'
//    amounts other than `landed_cost_cogs` (migration 0075, R45-2);
//  - the cost of sales part is recorded as a cost event of kind `landed_cost_cogs` (qty 0, the layer unchanged: the audit record of the
//    adjustment) and posts Dr cogs, on the cost center the request names, in the allocation's entry (R45-3). Sales and issues made before
//    the allocation keep the cost they took (no restatement, R45-5): the adjustment is dated the allocation;
//  - nothing sold: the stock part is the whole share and there is no cost of sales part, no cogs event and no cogs line (R45-6), exactly as
//    before Task 45;
//  - several allocations on one receipt are allowed and additive (a freight bill and a customs bill are two documents).
// Anular takes every share back with the opposite cost events of both kinds (never deleting anything; the cogs events again leave the layer
// alone, R45-4) and reverses the whole ledger entry, its cogs debit included, inline and strict
// through the rule `costing.landed_cost.voided` (reverseOf): when the entry cannot be reversed (a closed period) the void is refused and
// nothing is written. It restates nothing already issued either: it removes exactly the amounts it added, whatever the units have done
// since, so a void after units were issued lowers the layer's value (even below what the remaining units are worth, or below zero) and
// keeps value = Σ events = the ledger's inventory for the layer.
// The cost event of a landed cost has no movement line of its own: its movement_line_id is a generated id (unique per company) and the
// receipt line it answers to is landed_cost_lines.movement_line_id (and the event's source_line_id is the landed cost line).
// UI note (Task 10): several allocations on one receipt are legitimate, so a double click or a retry would allocate twice; the form must
// send an `idempotencyKey` (one per form submit) so a retry answers the first result.

const FEATURE = "costing.landed_costs";

export const LANDED_COST_ALLOCATED = "costing.landed_cost.allocated";
export const LANDED_COST_VOIDED = "costing.landed_cost.voided";
/** The prefix of a landed cost's number (company sequence, D9): Costo en Destino. */
export const LANDED_COST_PREFIX = "CD-";

const id = z.uuid();
const date = z.iso.date();
/** Money: up to two decimals (the ledger's cents). */
const money = z.number().finite().positive().max(1e13).refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Máximo dos decimales");
const weight = z.number().finite().positive().max(1e13).refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");

/** The offset roles the credit of which is owed to a supplier. */
const OWED_ROLES: readonly string[] = ["payable", "supplier_advances"];

const num = (v: string | null): number => Number(v);
const cents = (n: number): number => Math.round(n * 100);

export const allocateInput = z.object({
  /** The receipt (inventory.movement of kind receipt) the cost belongs to. */
  movementId: id,
  amount: money,
  basis: z.enum(LANDED_BASES),
  /** The account role credited: what the user names (the supplier's bill, an advance, cash, a bank or a suspense account). */
  offsetRole: z.enum(OFFSET_ROLES),
  /** The supplier whose bill it is (core.party): the credit to payable or to advances is owed to someone and the ledger asks for the tercero. */
  partyId: id.optional(),
  /** The cost center of the cost of sales part (Task 45): the share of units already sold posts Dr cogs, which may ask for one. */
  costCenterId: id.optional(),
  /** The date of the entry; defaults to today in the company's time zone. */
  date: date.optional(),
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  /** basis `weight` only: the total weight of each receipt line (the product has no weight field), in the unit the user prefers. */
  weights: z.array(z.object({ lineId: id, weight }).strict()).max(500).optional(),
  /** A retry of the same request answers the first run instead of allocating twice (several allocations on a receipt are legitimate). */
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
}).strict();

export const allocateOutput = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.literal("posted"),
  amount: z.number(),
  lines: z.array(z.object({ lineId: z.string(), movementLineId: z.string(), productId: z.string(), amount: z.number(), amountStock: z.number(), amountCogs: z.number(), unitCostAdded: z.number() })),
});

interface ReceiptEvent {
  id: string; movement_line_id: string; movement_seq: string; movement_number: string | null; product_id: string; category_id: string | null;
  warehouse_id: string; layer_id: string; qty: string; amount: string; currency: string; kind: string;
}

/**
 * The payload of `costing.landed_cost.allocated`: the rule posts Dr inventory per line (`cost`, the stock part), Dr cogs per line
 * (`cogsAdjustment`, the part of units already sold, on `costCenterId`; 0 when none, and the engine drops a zero line) / Cr the offset role
 * (`amount`).
 */
export interface LandedCostEvent {
  landedCostId: string;
  number: string;
  date: string;
  movementId: string;
  movementNumber: string | null;
  basis: LandedBasis;
  offsetRole: (typeof OFFSET_ROLES)[number];
  /** The supplier (core.party) the credit is owed to, when the request named one. */
  partyId?: string;
  /** The cost center of the cost of sales part, when the request named one. */
  costCenterId?: string;
  amount: number;
  reference: string | null;
  lines: {
    lineId: string; movementLineId: string; productId: string; categoryId: string | null; warehouseId: string; amount: number; cost: number; cogsAdjustment: number;
    costCenterId?: string;
  }[];
}

const today = async (ctx: ProcessContext): Promise<string> =>
  (await ctx.tx<{ today: string }[]>`select (now() at time zone timezone)::date::text as today from kernel.companies where id = ${ctx.companyId}`)[0]!.today;

/** Moves a layer's value by `amount` (signed) in the caller's transaction, under the layer row lock; returns the layer after. */
async function moveLayer(ctx: ProcessContext, layerId: string, amount: number): Promise<Layer> {
  const [row] = await ctx.tx<{ qty: string; value: string; avg_cost: string | null }[]>`
    select qty, value, avg_cost from costing.cost_layers where id = ${layerId} for update`;
  if (!row) throw new ProcessError("not_found", `cost layer ${layerId} not found`);
  const { after } = revalue({ qty: num(row.qty), value: num(row.value), avgCost: row.avg_cost === null ? null : num(row.avg_cost) }, amount);
  await ctx.tx`
    update costing.cost_layers set value = ${String(after.value)}::numeric, avg_cost = ${after.avgCost === null ? null : String(after.avgCost)}::numeric
    where id = ${layerId}`;
  return after;
}

/** A layer as it is, under its row lock (a cost of sales part leaves it unchanged). */
async function readLayer(ctx: ProcessContext, layerId: string): Promise<Layer> {
  const [row] = await ctx.tx<{ qty: string; value: string; avg_cost: string | null }[]>`
    select qty, value, avg_cost from costing.cost_layers where id = ${layerId} for update`;
  if (!row) throw new ProcessError("not_found", `cost layer ${layerId} not found`);
  return { qty: num(row.qty), value: num(row.value), avgCost: row.avg_cost === null ? null : num(row.avg_cost) };
}

/** The kinds of a landed cost's own cost events: the stock part and the cost of sales part (Task 45). */
type ShareKind = "landed_cost" | "landed_cost_cogs";

/** Writes the cost event of one share part (or of its reversal) beside the receipt's own events. */
async function writeShareEvent(
  ctx: ProcessContext,
  receipt: Pick<ReceiptEvent, "movement_seq" | "movement_number" | "product_id" | "category_id" | "warehouse_id" | "layer_id" | "currency"> & { movement_id: string },
  on: { kind: ShareKind; date: string; amount: number; unitCost: number; after: Layer; landedCostId: string; landedLineId: string },
): Promise<void> {
  await ctx.tx`
    insert into costing.cost_events ${ctx.tx({
      company_id: ctx.companyId,
      movement_id: receipt.movement_id,
      // A landed cost has no movement line of its own (the receipt line it answers to is source_line_id): a fresh id keeps the key unique.
      movement_line_id: (await ctx.tx<{ id: string }[]>`select kernel.uuid_v7() as id`)[0]!.id,
      movement_seq: Number(receipt.movement_seq),
      movement_number: receipt.movement_number,
      kind: on.kind,
      date: on.date,
      product_id: receipt.product_id,
      category_id: receipt.category_id,
      warehouse_id: receipt.warehouse_id,
      layer_id: receipt.layer_id,
      qty: 0,
      unit_cost: on.unitCost,
      amount: on.amount,
      cost_source: on.kind,
      cost_missing: false,
      qty_after: on.after.qty,
      value_after: on.after.value,
      avg_after: on.after.avgCost,
      currency: receipt.currency,
      exchange_rate: 1,
      source_entity: "costing.landed_cost",
      source_id: on.landedCostId,
      source_line_id: on.landedLineId,
    })}`;
}

/**
 * Spreads `input.amount` over the lines of the receipt, raises their layers, writes the document and its lines, and numbers and posts it
 * through the lifecycle. See the header of this file for the rules.
 */
export async function allocateLandedCost(ctx: ProcessContext, input: z.output<typeof allocateInput>): Promise<z.output<typeof allocateOutput>> {
  // One costing write at a time per company: the layers and the events are written in the order they commit.
  await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${feedLockKey(ctx.companyId)}, 0))`;
  const events = await ctx.tx<ReceiptEvent[]>`
    select e.id, e.movement_line_id, e.movement_seq, e.movement_number, e.product_id, e.category_id, e.warehouse_id, e.layer_id, e.qty, e.amount, e.currency, e.kind
    from costing.cost_events e
    where e.company_id = ${ctx.companyId} and e.movement_id = ${input.movementId} and e.kind not in ('landed_cost', 'landed_cost_cogs', 'reversal')
    order by e.movement_seq, e.seq`;
  if (events.length === 0) {
    refuse("movement_not_costed", ["El movimiento no existe o todavía no está valorizado: el costo se reparte sobre una entrada ya valorizada"]);
  }
  if (events.some((e) => e.kind !== "receipt")) {
    refuse("not_a_receipt", ["El costo en destino se reparte sobre una entrada de mercancía (recibo), no sobre otro tipo de movimiento"]);
  }
  // The movement must still be in the stock: inventory publishes its status through the feed (read only inside a costing process).
  const [fed] = await ctx.tx<{ status: string }[]>`select status from inventory.movement_feed(${Number(events[0]!.movement_seq) - 1}, ${input.movementId}) limit 1`;
  if (fed?.status === "voided") refuse("movement_voided", ["La entrada está anulada: no se le puede repartir un costo"]);

  // The base of each line.
  let bases: number[];
  if (input.basis === "weight") {
    const asked = (input.weights ?? []).map((w) => w.lineId);
    if (new Set(asked).size !== asked.length) refuse("weights_required", ["Una línea de la entrada tiene dos pesos: indica uno solo"]);
    const given = new Map((input.weights ?? []).map((w) => [w.lineId, w.weight] as const));
    const missing = events.flatMap((e, i) => (given.has(e.movement_line_id) ? [] : [`Línea ${i + 1}: falta el peso`]));
    if (missing.length > 0) refuse("weights_required", missing);
    const unknown = (input.weights ?? []).filter((w) => !events.some((e) => e.movement_line_id === w.lineId));
    if (unknown.length > 0) refuse("weights_required", unknown.map(() => "Un peso indicado no es de ninguna línea de la entrada"));
    bases = events.map((e) => Math.round(given.get(e.movement_line_id)! * 1e4));
  } else {
    if (input.weights) refuse("weights_not_applicable", ["Los pesos solo se indican cuando el reparto es por peso"]);
    bases = input.basis === "value" ? events.map((e) => cents(num(e.amount))) : events.map((e) => Math.round(num(e.qty) * 1e4));
  }
  let shares: number[];
  try {
    shares = distribute(cents(input.amount), bases);
  } catch (error) {
    if (error instanceof CostError) refuse("nothing_to_distribute", ["Las líneas de la entrada no tienen con qué repartir el valor (valor cero): reparte por cantidad o por peso"]);
    throw error;
  }

  if (OWED_ROLES.includes(input.offsetRole) && !input.partyId) refuse("party_required", ["Indica el proveedor: el crédito a cuentas por pagar o a anticipos se debe a un tercero"]);

  // R45-1: the units of each line still on hand (the layer's quantity now, given to the lines of one layer in order) split its share.
  const onHandLeft = new Map<string, number>();
  for (const e of events) {
    if (!onHandLeft.has(e.layer_id)) onHandLeft.set(e.layer_id, Math.max(0, (await readLayer(ctx, e.layer_id)).qty));
  }
  const parts = events.map((e, i) => {
    const received = num(e.qty);
    const onHand = Math.min(received, onHandLeft.get(e.layer_id)!);
    onHandLeft.set(e.layer_id, round4(onHandLeft.get(e.layer_id)! - onHand));
    return { onHand, sold: round4(received - onHand), ...splitShare(shares[i]!, received, onHand) };
  });

  const on = input.date ?? (await today(ctx));
  const [header] = await ctx.tx<{ id: string }[]>`
    insert into costing.landed_costs ${ctx.tx({
      company_id: ctx.companyId,
      date: on,
      movement_id: input.movementId,
      movement_number: events[0]!.movement_number,
      basis: input.basis,
      amount: input.amount,
      offset_role: input.offsetRole,
      party_id: input.partyId ?? null,
      cost_center_id: input.costCenterId ?? null,
      reference: input.reference ?? null,
      description: input.description ?? null,
      currency: events[0]!.currency,
      // The allocation is applied in this very action: the validate hook (Grabar) refuses a Borrador that was never applied.
      applied_at: new Date(),
      // An allocation never waits for approval and always posts (ownFlags): explicit, so the Parámetros switches never apply.
      requires_approval: false,
      posts: true,
    })}
    returning id`;
  const landedCostId = header!.id;
  const lineRows = events.map((e, i) => ({
    company_id: ctx.companyId,
    landed_cost_id: landedCostId,
    line_no: i + 1,
    movement_line_id: e.movement_line_id,
    product_id: e.product_id,
    warehouse_id: e.warehouse_id,
    qty: num(e.qty),
    base: input.basis === "value" ? num(e.amount) : input.basis === "quantity" ? num(e.qty) : bases[i]! / 1e4,
    weight: input.basis === "weight" ? bases[i]! / 1e4 : null,
    amount: shares[i]! / 100,
    amount_stock: parts[i]!.stock / 100,
    amount_cogs: parts[i]!.cogs / 100,
    unit_cost_added: round4(shares[i]! / 100 / num(e.qty)),
  }));
  const inserted = await ctx.tx<{ id: string; line_no: number }[]>`insert into costing.landed_cost_lines ${ctx.tx(lineRows)} returning id, line_no`;
  const lineIds = new Map(inserted.map((r) => [r.line_no, r.id]));

  for (const [i, e] of events.entries()) {
    const { stock, cogs, sold } = parts[i]!;
    const at = { date: on, landedCostId, landedLineId: lineIds.get(i + 1)! };
    if (stock > 0) {
      const after = await moveLayer(ctx, e.layer_id, stock / 100);
      await writeShareEvent(ctx, { ...e, movement_id: input.movementId }, { ...at, kind: "landed_cost", amount: stock / 100, unitCost: lineRows[i]!.unit_cost_added, after });
    }
    if (cogs > 0) {
      // The cost of sales part leaves the layer as it is (R45-2): the event records it, the entry posts it.
      const after = await readLayer(ctx, e.layer_id);
      await writeShareEvent(ctx, { ...e, movement_id: input.movementId }, { ...at, kind: "landed_cost_cogs", amount: cogs / 100, unitCost: round4(cogs / 100 / sold), after });
    }
  }

  // Grabar: the number (on save) and the posting (Contabiliza): the post hook emits costing.landed_cost.allocated.
  const saved = await runLifecycle(ctx, ctx.registry.entity(landedCostEntity.id), landedCostId, "save");
  return {
    id: landedCostId,
    number: saved.number ?? null,
    status: "posted",
    amount: input.amount,
    lines: lineRows.map((r) => ({
      lineId: lineIds.get(r.line_no)!, movementLineId: r.movement_line_id, productId: r.product_id, amount: r.amount, amountStock: r.amount_stock, amountCogs: r.amount_cogs,
      unitCostAdded: r.unit_cost_added,
    })),
  };
}

export const landedCostAllocate = defineProcess({
  id: "costing.landed_cost.allocate",
  module: "costing",
  kind: "create",
  feature: FEATURE,
  emits: [LANDED_COST_ALLOCATED],
  recordAccess: "none",
  description:
    "Reparte un costo en destino (flete, aranceles, seguro) sobre las líneas de una entrada de mercancía ya valorizada, por valor, cantidad o peso: la parte de las unidades que siguen en existencia sube el valor de sus capas de costo y la de las unidades ya vendidas va al costo de ventas del período; contabiliza Dr inventario y Dr costo de ventas (con el centro de costo que se indica) / Cr el rol de contrapartida; varios repartos sobre una entrada se suman",
  input: allocateInput,
  output: allocateOutput,
  // A retry of the same request (same key) answers the first run; without a key every call is a new allocation.
  idempotencyKey: (input) => (input.idempotencyKey ? `landed:${input.movementId}:${input.idempotencyKey}` : undefined),
  handler: (ctx, input) => allocateLandedCost(ctx, input),
});

export const voidInput = z.object({ id, reason: z.string().trim().min(1, "Indica el motivo").max(1000), date: date.optional(), expectedUpdatedAt: z.iso.datetime({ offset: true }).optional() }).strict();

export const landedCostVoid = defineProcess({
  id: "costing.landed_cost.void",
  module: "costing",
  kind: "update",
  feature: FEATURE,
  sensitivity: "step-up",
  emits: [LANDED_COST_VOIDED],
  description:
    "Anula un costo en destino con el motivo: quita de las capas de costo exactamente lo que repartió y devuelve lo que llevó al costo de ventas, con eventos de costo opuestos, y revierte su asiento contable; el documento queda anulado, nunca se borra, y las salidas ya hechas no se recalculan",
  input: voidInput,
  output: z.object({ id: z.string(), status: z.literal("voided"), number: z.string().nullable() }),
  handler: async (ctx, { id: landedCostId, reason, date: given, expectedUpdatedAt }) => {
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${feedLockKey(ctx.companyId)}, 0))`;
    const [record] = await ctx.tx<TypedRecord[]>`select * from costing.landed_costs where id = ${landedCostId} for update`;
    if (!record) throw new ProcessError("not_found", `costing.landed_cost ${landedCostId} not found`);
    if (expectedUpdatedAt && new Date(record.updated_at as string).getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new ProcessError("stale_record", `costing.landed_cost ${landedCostId} changed since it was read`);
    }
    // The lifecycle's own table (D3) refuses a void from posted; a posted landed cost is undone here, through the reversal path.
    if (record.status !== "posted") {
      throw new ProcessError("invalid_state", `costing.landed_cost ${landedCostId}: void is not allowed in status ${record.status}`, { details: { from: record.status, action: "void" } });
    }
    const shares = await ctx.tx<(ReceiptEvent & { source_line_id: string; unit_cost: string })[]>`
      select e.id, e.movement_line_id, e.movement_seq, e.movement_number, e.product_id, e.category_id, e.warehouse_id, e.layer_id, e.qty, e.amount, e.currency, e.kind,
             e.source_line_id, e.unit_cost
      from costing.cost_events e
      where e.company_id = ${ctx.companyId} and e.kind in ('landed_cost', 'landed_cost_cogs') and e.source_id = ${landedCostId}
      order by e.seq`;
    const on = given ?? (await today(ctx));
    for (const share of shares) {
      const amount = -num(share.amount);
      const kind = share.kind as ShareKind;
      // The stock part comes out of the layer; the cost of sales part never was in it (R45-4): its opposite event leaves the layer alone.
      const after = kind === "landed_cost" ? await moveLayer(ctx, share.layer_id, amount) : await readLayer(ctx, share.layer_id);
      await writeShareEvent(ctx, { ...share, movement_id: record.movement_id as string }, {
        kind, date: on, amount, unitCost: num(share.unit_cost), after, landedCostId, landedLineId: share.source_line_id,
      });
    }
    const [voided] = await ctx.tx<TypedRecord[]>`
      update costing.landed_costs set status = 'voided', void_reason = ${reason} where id = ${landedCostId} returning *`;
    const entity = ctx.registry.entity(landedCostEntity.id);
    await writeSnapshot(ctx, entity, landedCostId, "voided", reason);
    await emitStatusChanged(ctx, entity, { id: landedCostId, number: voided!.number }, "posted" as RecordStatus, "voided");
    // An allocation whose event is still parked (accounting was off) must never reach the ledger after this void: dismiss it.
    await dismissParkedEvents(ctx, LANDED_COST_ALLOCATED, { landedCostId });
    // The reversal of the allocation's entry, inline and strict: a closed period (or any refusal) undoes the whole void.
    await emitAndPostStrict(ctx, LANDED_COST_VOIDED, { landedCostId, number: voided!.number as string, date: on, reason }, { requireRule: true });
    return { id: landedCostId, status: "voided" as const, number: (voided!.number as string | null) ?? null };
  },
});

const idInput = z.object({ id });

export const landedCostConsult = defineProcess({
  id: "costing.landed_cost.consult",
  module: "costing",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un costo en destino con lo que se repartió a cada línea de la entrada y los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string(), lines: z.array(z.looseObject({ id: z.string() })) }),
  handler: async (ctx, { id: landedCostId }) => {
    const [row] = await ctx.tx`select * from costing.v_landed_costs where id = ${landedCostId}`;
    if (!row) throw new ProcessError("not_found", `landed cost ${landedCostId} not found`);
    const lines = await ctx.tx<{ id: string }[]>`select * from costing.v_landed_cost_lines where landed_cost_id = ${landedCostId} order by line_no`;
    return { ...row, id: landedCostId, extra: await visibleExtra(ctx, "costing.landed_cost", row.extra), lines };
  },
});

export const landedCostLineConsult = defineProcess({
  id: "costing.landed_cost_line.consult",
  module: "costing",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta la línea de un costo en destino: cuánto se repartió a una línea de la entrada y cuánto subió su costo unitario",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lineId }) => {
    const [row] = await ctx.tx`select * from costing.v_landed_cost_lines where id = ${lineId}`;
    if (!row) throw new ProcessError("not_found", `landed cost line ${lineId} not found`);
    return { ...row, id: lineId };
  },
});

/**
 * The lifecycle hooks of a landed cost (Grabar): it reaches the layers only through costing.landed_cost.allocate (a Borrador never applied
 * is refused), once allocated it does not change (correcting it is Anular and allocating again), it numbers on save, and its post step
 * emits the event the ledger rules post (the layers were raised by the action before; this is the entry).
 */
export const landedCostHooks: TypedHooks = {
  async validate(_ctx, record, mode, { previous, data }) {
    if (mode !== "save") return;
    if (previous.status === "draft" && !record.applied_at) {
      refuse("invalid_landed_cost", ["Un costo en destino se registra con «Repartir costo en destino», que lo reparte sobre la entrada"]);
    }
    if (previous.status !== "draft" && data && Object.keys(data).length > 0) {
      refuse("invalid_landed_cost", ["Un costo en destino repartido no cambia: anúlalo y reparte otro"]);
    }
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select costing.next_document_number(${ctx.companyId}, ${LANDED_COST_PREFIX}) as number`;
    return row!.number;
  },
  async post(ctx, record) {
    // Read back as text: the event carries the date as the ledger reads it (YYYY-MM-DD) and the amounts as numbers.
    const [head] = await ctx.tx<{ number: string; date: string; movement_id: string; movement_number: string | null; basis: LandedBasis; offset_role: LandedCostEvent["offsetRole"]; party_id: string | null; cost_center_id: string | null; amount: string; reference: string | null }[]>`
      select number, date::text as date, movement_id, movement_number, basis, offset_role, party_id, cost_center_id, amount, reference from costing.landed_costs where id = ${record.id}`;
    const lines = await ctx.tx<{ id: string; movement_line_id: string; product_id: string; warehouse_id: string; amount: string; amount_stock: string; amount_cogs: string; category_id: string | null }[]>`
      select l.id, l.movement_line_id, l.product_id, l.warehouse_id, l.amount, l.amount_stock, l.amount_cogs,
             (select e.category_id from costing.cost_events e where e.company_id = l.company_id and e.kind in ('landed_cost', 'landed_cost_cogs') and e.source_line_id = l.id order by e.seq limit 1) as category_id
      from costing.landed_cost_lines l where l.landed_cost_id = ${record.id} order by l.line_no`;
    const center = head!.cost_center_id ? { costCenterId: head!.cost_center_id } : {};
    const event: LandedCostEvent = {
      landedCostId: record.id,
      number: head!.number,
      date: head!.date,
      movementId: head!.movement_id,
      movementNumber: head!.movement_number,
      basis: head!.basis,
      offsetRole: head!.offset_role,
      ...(head!.party_id ? { partyId: head!.party_id } : {}),
      ...center,
      amount: num(head!.amount),
      reference: head!.reference,
      lines: lines.map((l) => ({
        lineId: l.id, movementLineId: l.movement_line_id, productId: l.product_id, categoryId: l.category_id,
        warehouseId: l.warehouse_id, amount: num(l.amount), cost: num(l.amount_stock), cogsAdjustment: num(l.amount_cogs), ...center,
      })),
    };
    // Inline and strict (D8): the entry is in the ledger when this action commits, or the action does not happen.
    await emitAndPostStrict(ctx, LANDED_COST_ALLOCATED, event, { requireRule: true });
  },
};

export const LANDED_COST_PROCESSES = [landedCostAllocate, landedCostVoid, landedCostConsult, landedCostLineConsult];
