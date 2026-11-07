"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import type { SaveResult } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { stepRefusal } from "@/lib/records/step-refusal";
import { issuesOf } from "@/lib/records/issues";
import { processDeps } from "@/lib/server/runtime";
import { STOCK_STEP_PROCESSES } from "./record";

// The inventory and costing screens' server side (plan 2B Task 10, rule 1): every button runs a registered process as the session's user,
// with the step-up token when the user just verified one (an ajuste, Aplicar conteo and the costing method are sensitive, rule 15). A
// refusal comes back as data for the form; `step_up_required` makes the screen ask for the code and send the same input again.

/**
 * The create processes the stock document forms save through, keyed by entity and variant (plan 2B Task 14b): the server picks the process,
 * the form only says which entity it saves and, for a Movimiento, whether it is an ajuste (`__variant`).
 */
const CREATE_PROCESSES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "inventory.movement": { default: "inventory.movement.post", adjustment: "inventory.adjustment.post" },
  "inventory.transfer": { default: "inventory.transfer.create" },
  "inventory.count": { default: "inventory.count.create" },
  "costing.landed_cost": { default: "costing.landed_cost.allocate" },
};
const VARIANT_KEY = "__variant";

export type StepOutcome = { ok: true } | { ok: false; code: string; messages: string[] };

/** Saves a new movimiento, ajuste, traslado, conteo or costo en destino through its entity's create process. */
export async function saveStockDocumentAction(entity: string, input: Record<string, unknown>, stepUpToken?: string): Promise<SaveResult> {
  if (typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", details: [] };
  const { [VARIANT_KEY]: variant, ...body } = input;
  const process = Object.hasOwn(CREATE_PROCESSES, entity) ? CREATE_PROCESSES[entity]![typeof variant === "string" ? variant : "default"] : undefined;
  if (typeof process !== "string") return { ok: false, code: "invalid_input", details: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    const result = (await runProcess(processDeps(), caller, process, body)) as { id: string | null; status?: string };
    // A movement of products that keep no stock moves nothing: there is no record to open.
    if (!result.id) return { ok: false, code: "nothing_moved", details: [] };
    return { ok: true, id: result.id };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}

/**
 * A step of a stored traslado or conteo: Despachar, Recibir, Registrar conteo (the counted quantities), Aplicar conteo (step-up). The
 * process comes from the entity and the step's name (STOCK_STEP_PROCESSES), never from the client.
 */
export async function runStockStepAction(entity: string, verb: string, input: Record<string, unknown>, stepUpToken?: string): Promise<StepOutcome> {
  const steps = Object.hasOwn(STOCK_STEP_PROCESSES, entity) ? STOCK_STEP_PROCESSES[entity]! : null;
  const step = steps && Object.hasOwn(steps, verb) ? steps[verb]! : null;
  if (!step || typeof input !== "object" || input === null || typeof input.id !== "string") return { ok: false, code: "invalid_input", messages: [] };
  const body: Record<string, unknown> = { id: input.id };
  if (step === "inventory.count.record") body.lines = input.lines;
  if (step === "inventory.count.apply" && typeof input.reason === "string" && input.reason.trim()) body.reason = input.reason.trim();
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    await runProcess(processDeps(), caller, step, body);
    return { ok: true };
  } catch (error) {
    return stepRefusal(error);
  }
}

/** Parámetros › Costeo: the company's costing method (step-up; FIFO is refused until phase 3). */
export async function saveCostingMethodAction(method: string, stepUpToken?: string): Promise<StepOutcome> {
  if (method !== "average" && method !== "fifo") return { ok: false, code: "invalid_input", messages: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    await runProcess(processDeps(), caller, "costing.settings.update", { method });
    return { ok: true };
  } catch (error) {
    return stepRefusal(error);
  }
}

/** Parámetros › Costeo: what a unit without a known cost is valued at, `zero` or `last_known` (step-up; Task 44, owner item 36). */
export async function saveUnknownCostModeAction(mode: string, stepUpToken?: string): Promise<StepOutcome> {
  if (mode !== "zero" && mode !== "last_known") return { ok: false, code: "invalid_input", messages: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    await runProcess(processDeps(), caller, "costing.unknown_cost.set", { mode });
    return { ok: true };
  } catch (error) {
    return stepRefusal(error);
  }
}
