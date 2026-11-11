// The weighted average of one layer (plan 2B Task 8, OD-5), as pure arithmetic: the processes read and write the layers, this file says
// what an entry or an exit does to them. Quantities carry 4 decimals, money 2 (the ledger's cents, half away from zero, design §10a.8).
// The subledger reconciles (controller ruling, Task 8 review): for every shape, value after = value before + the signed amount of the line,
// so the layer's value is always the sum of its cost events' amounts (and of the ledger postings made from them).
//  - The average is derived at read time: value / qty at full precision while qty > 0 (never below 0); otherwise the last known average.
//    `avgCost` on the layer is that snapshot rounded to 4 decimals, for display and for the event's unit cost.
//  - An entry (receipt, return, transfer in, positive adjustment) adds round2(qty × unit cost). Into a layer at or below zero (a bodega
//    with backorders) the value still just adds: (−3, −300) + 10 @ 120 → (7, 900), average 128.57; no value vanishes.
//  - An exit (issue, sale issue, transfer out, negative adjustment) takes round2(qty × the average), or qty × the given cost (an adjustment
//    valued by inventory), exactly, even past the layer's value or below zero units. Taking the whole remaining quantity at the average takes
//    the whole remaining value, so no cent stays behind.
//  - A negative cost is refused.

export interface Layer {
  qty: number;
  value: number;
  /** null until the layer has ever had a cost. */
  avgCost: number | null;
}

export class CostError extends Error {
  constructor(readonly code: "negative_cost_refused" | "invalid_quantity", message: string) {
    super(`${code}: ${message}`);
  }
}

export const round2 = (n: number): number => (Math.sign(n) * Math.round(Math.abs(n) * 100)) / 100 || 0;
export const round4 = (n: number): number => (Math.sign(n) * Math.round(Math.abs(n) * 1e4)) / 1e4 || 0;

export const EMPTY_LAYER: Layer = { qty: 0, value: 0, avgCost: null };

/** The layer's average cost at full precision: value / qty while it holds units (never below 0), else the last known average. */
export function averageOf(layer: Layer): number | null {
  return layer.qty > 0 ? Math.max(layer.value / layer.qty, 0) : layer.avgCost;
}

/** The average snapshot after a change: value / qty when units remain, else `fallback` (the last known average). */
const snapshot = (qty: number, value: number, fallback: number | null): number | null => (qty > 0 ? round4(Math.max(value / qty, 0)) : fallback);

function checkCost(unitCost: number): void {
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new CostError("negative_cost_refused", `El costo unitario no puede ser negativo (${unitCost})`);
}
function checkQty(qty: number): void {
  if (!Number.isFinite(qty) || qty <= 0) throw new CostError("invalid_quantity", `La cantidad debe ser positiva (${qty})`);
}

/** An entry of `qty` (> 0) units at `unitCost` (≥ 0). Returns the amount added (2 decimals) and the layer after (value = before + amount). */
export function enter(layer: Layer, qty: number, unitCost: number): { amount: number; after: Layer } {
  checkQty(qty);
  checkCost(unitCost);
  const amount = round2(qty * unitCost);
  const qtyAfter = round4(layer.qty + qty);
  const value = round2(layer.value + amount);
  return { amount, after: { qty: qtyAfter, value, avgCost: snapshot(qtyAfter, value, round4(unitCost)) } };
}

/**
 * An exit of `qty` (> 0) units, at the layer's average or at `unitCost` when given (an adjustment valued by inventory). Returns the unit
 * cost used (4 decimals), the amount taken (positive, 2 decimals) and the layer after (value = before − amount). A layer without a cost
 * gives 0 (the caller flags it).
 */
export function exit(layer: Layer, qty: number, unitCost?: number): { unitCost: number; amount: number; after: Layer } {
  checkQty(qty);
  if (unitCost !== undefined) checkCost(unitCost);
  const cost = unitCost ?? averageOf(layer) ?? 0;
  const qtyAfter = round4(layer.qty - qty);
  const whole = unitCost === undefined && layer.qty > 0 && qtyAfter === 0 && layer.value >= 0;
  const amount = whole ? round2(layer.value) : round2(qty * cost);
  const value = round2(layer.value - amount);
  return { unitCost: round4(cost), amount, after: { qty: qtyAfter, value, avgCost: snapshot(qtyAfter, value, layer.avgCost ?? (unitCost === undefined ? null : round4(unitCost))) } };
}

/**
 * A landed cost (freight, duties, insurance) added to a layer, or taken back by a void when `amount` is negative: the value moves by
 * the amount (2 decimals) and the quantity does not, so the average of the units that remain moves with it. The layer's value stays
 * the sum of its cost events' amounts (the reconciliation rule above). A layer with no units keeps its last average and holds the
 * value, as an entry into a layer at or below zero does: no value vanishes, the next entry's average carries it.
 */
export function revalue(layer: Layer, amount: number): { amount: number; after: Layer } {
  if (!Number.isFinite(amount)) throw new CostError("invalid_quantity", `El valor no es válido (${amount})`);
  const value = round2(layer.value + amount);
  return { amount: round2(amount), after: { qty: layer.qty, value, avgCost: snapshot(layer.qty, value, layer.avgCost) } };
}

/**
 * The void of one cost event (Task 14): the layer takes back exactly the event's signed `qty` and `amount` (both negated), so the layer's
 * value stays the sum of its events' amounts and a movement voided right after it was valued leaves the layer as it was. Units entered at
 * a cost and voided after later exits may leave the layer's value away from qty × average (the units that left were valued at the
 * average of their day); the average is then read from what remains, as for any change.
 */
export function reverse(layer: Layer, qty: number, amount: number): { qty: number; amount: number; after: Layer } {
  if (!Number.isFinite(qty) || !Number.isFinite(amount)) throw new CostError("invalid_quantity", `La reversión no es válida (${qty}, ${amount})`);
  const back = { qty: round4(-qty), amount: round2(-amount) };
  const qtyAfter = round4(layer.qty + back.qty);
  const value = round2(layer.value + back.amount);
  return { ...back, after: { qty: qtyAfter, value, avgCost: snapshot(qtyAfter, value, layer.avgCost) } };
}

/**
 * Whether an exit of `qty` (> 0) units valued at an ESTIMATED `unitCost` (Task 44, R44-6 as amended in fix round 1) is allowed: only when the
 * layer holds no units. Units held at value 0 leave at 0 (the caller flags them): an estimate would take value that never entered the layer
 * and dilute the next real receipt, the very effect the setting exists to avoid.
 */
export function exitEstimateFits(layer: Layer, qty: number, unitCost: number): boolean {
  checkQty(qty);
  checkCost(unitCost);
  return layer.qty <= 0;
}
