import { defineProcess } from "@erp/kernel";
import { z } from "zod";
import { id, savedMovementId } from "./common";
import { MOVEMENT_POSTED, movementLineInput, postedOutput, postMovement, type PostedMovement } from "./movement";

// Ajustes de inventario (plan 2B Task 7, design §8.1, rule 15). An adjustment is a movement of kind `adjustment` whose lines carry either
// sign (+ a gain, − a loss). Changing stock without a document is the most abusable act of the module, so the process is SENSITIVE
// (a fresh TOTP step-up bound to the user, ≤ 5 minutes) and needs a reason, kept as the movement's description. It emits
// `inventory.movement.posted` kind `adjustment` with the value of each line (qty × cost: the line's, else the product's standard cost):
// the 2A rule `inventory-adjustment` posts it (Dr/Cr inventory against the adjustment account) only for that kind. An adjustment is never
// voided (it is corrected by another one). A count applies its differences through postAdjustment too, under its own step-up.

const FEATURE = "inventory.stock";

const date = z.iso.date();
export const reason = z.string().trim().min(3, "Indica el motivo del ajuste").max(500);

/** A line of an adjustment: a movement line without a source line (the source is the count that applies it, internally) nor a returned sale. */
export const adjustmentLineInput = movementLineInput.omit({ sourceLineId: true, returnOf: true });

export const adjustmentInput = z.object({
  date,
  warehouseId: id,
  reason,
  reference: z.string().trim().max(100).optional(),
  /** The cost center of the ledger entry, when the company's adjustment account requires one (an id of accounting). */
  costCenterId: id.optional(),
  lines: z.array(adjustmentLineInput).min(1).max(500),
}).strict();

export interface AdjustmentRequest {
  date: string;
  warehouseId: string;
  reason: string;
  reference?: string | undefined;
  costCenterId?: string | undefined;
  lines: (z.output<typeof adjustmentLineInput> & { sourceLineId?: string | undefined })[];
  /** The document that causes it (a count): its lines are the idempotency keys. */
  sourceEntity?: string;
  sourceId?: string;
}

/** Posts the adjustment movement (the caller has already passed the step-up gate of its own process). */
export function postAdjustment(ctx: Parameters<typeof postMovement>[0], request: AdjustmentRequest): Promise<PostedMovement> {
  return postMovement(ctx, {
    kind: "adjustment",
    date: request.date,
    warehouseId: request.warehouseId,
    description: request.reason,
    ...(request.reference ? { reference: request.reference } : {}),
    ...(request.costCenterId ? { costCenterId: request.costCenterId } : {}),
    ...(request.sourceEntity && request.sourceId ? { sourceEntity: request.sourceEntity, sourceId: request.sourceId } : {}),
    lines: request.lines,
  });
}

export const adjustmentPost = defineProcess({
  id: "inventory.adjustment.post",
  module: "inventory",
  kind: "create",
  recordAccess: "none",
  sensitivity: "step-up",
  feature: FEATURE,
  emits: [MOVEMENT_POSTED],
  description:
    "Registra un ajuste de inventario (cantidades positivas suman, negativas restan) con su motivo; requiere verificación reforzada; rechaza dejar existencias negativas si la bodega no lo permite; contabilidad lo registra con el costo de cada línea",
  input: adjustmentInput,
  output: postedOutput,
  handler: async (ctx, input) => {
    const posted = await postAdjustment(ctx, input);
    // A skipped adjustment (every product keeps no stock) is a valid answer; a voided one cannot occur without a source line.
    if (posted.status === "voided") savedMovementId(posted, "El ajuste");
    return posted;
  },
});

export const ADJUSTMENT_PROCESSES = [adjustmentPost];
