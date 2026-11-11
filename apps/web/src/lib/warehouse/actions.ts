"use server";

import { runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { defined, isUuid, num, text } from "@/lib/records/step-helpers";
import { stepRefusal } from "@/lib/records/step-refusal";
import { processDeps } from "@/lib/server/runtime";
import { WAREHOUSE_STEPS } from "./record";
import { labelSuggestion, type SuggestionLineView } from "./screens";

// The Bodega screens' server side (plan 2B.2 Task 29.4, rule 1): every button runs a registered process as the session's user, with the
// step-up token when the user just verified one (Configuración is an admin process, rule 15). The process comes from the entity and the
// step's name (WAREHOUSE_STEPS) or from the screen's own allowlist, never from the client; each input is rebuilt here from what the screen
// may send. A refusal comes back as data; `step_up_required` makes the screen ask for the code and send the same input again.

export type WarehouseOutcome = { ok: true; id?: string } | { ok: false; code: string; messages: string[] };

const caller = async (stepUpToken?: string) => ({ ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) });

/** A picked line as the alistamiento's update and confirm take it (`pickedInput`). */
function pickedLine(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null) return null;
  const l = v as Record<string, unknown>;
  const qtyPicked = num(l.qtyPicked);
  if (!isUuid(l.pickLineId) || qtyPicked === undefined) return null;
  const ref = (x: unknown) => (x === null ? null : isUuid(x) ? x : undefined);
  return defined({ pickLineId: l.pickLineId, locationId: ref(l.locationId), lotId: ref(l.lotId), serialId: ref(l.serialId), qtyPicked });
}

/** A package as the empaque's update takes it (`packageInput`). */
function packageOf(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  const packageNo = num(p.packageNo);
  if (packageNo === undefined || !Array.isArray(p.lines)) return null;
  const lines = p.lines.flatMap((x) => {
    const l = x as Record<string, unknown>;
    const qty = num(l?.qty);
    return isUuid(l?.pickLineId) && qty !== undefined ? [{ pickLineId: l.pickLineId, qty }] : [];
  });
  return defined({ packageNo, weightKg: num(p.weightKg), dimensions: text(p.dimensions), lines });
}

/** A step of a stored alistamiento or empaque: Iniciar, Guardar, Confirmar, Crear empaque; Guardar paquetes, Cerrar. */
export async function runWarehouseStepAction(entity: string, step: string, recordId: string, input: Record<string, unknown> = {}, stepUpToken?: string): Promise<WarehouseOutcome> {
  const steps = Object.hasOwn(WAREHOUSE_STEPS, entity) ? WAREHOUSE_STEPS[entity]! : null;
  const process = steps && Object.hasOwn(steps, step) ? steps[step]! : null;
  if (!process || !isUuid(recordId) || typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", messages: [] };
  let body: Record<string, unknown> = { id: recordId };
  if (process === "warehouse.pick.update" || process === "warehouse.pick.confirm") {
    const lines = Array.isArray(input.lines) ? input.lines.map(pickedLine) : [];
    if (lines.some((l) => l === null)) return { ok: false, code: "invalid_input", messages: [] };
    // «Confirmar» with no line touched takes the proposal (owner item 217).
    if (lines.length > 0) body.lines = lines;
    else if (process === "warehouse.pick.update") return { ok: false, code: "nothing_to_change", messages: [] };
  }
  if (process === "warehouse.pack.create") body = { pickId: recordId };
  if (process === "warehouse.pack.update") {
    const packages = Array.isArray(input.packages) ? input.packages.map(packageOf) : [];
    if (packages.length === 0 || packages.some((p) => p === null)) return { ok: false, code: "invalid_input", messages: [] };
    body.packages = packages;
  }
  try {
    const out = (await runProcess(processDeps(), await caller(stepUpToken), process, body)) as { id?: unknown } | null;
    // Crear empaque opens the empaque it made (or the one the alistamiento already had).
    return process === "warehouse.pack.create" && out && typeof out.id === "string" ? { ok: true, id: out.id } : { ok: true };
  } catch (error) {
    return stepRefusal(error);
  }
}

/** Parámetros › Configuración: the two switches (warehouse.settings.update, step-up). */
export async function saveWarehouseSettingsAction(input: { autoPickOnConfirm?: unknown; deliveryFromPick?: unknown }, stepUpToken?: string): Promise<WarehouseOutcome> {
  const body = defined({
    autoPickOnConfirm: typeof input?.autoPickOnConfirm === "boolean" ? input.autoPickOnConfirm : undefined,
    deliveryFromPick: typeof input?.deliveryFromPick === "boolean" ? input.deliveryFromPick : undefined,
  });
  try {
    await runProcess(processDeps(), await caller(stepUpToken), "warehouse.settings.update", body);
    return { ok: true };
  } catch (error) {
    return stepRefusal(error);
  }
}

/** Parámetros › Reglas de ubicación: create, change or delete one rule (warehouse.putaway_rule.*). */
export async function saveRuleAction(op: "create" | "update" | "delete", input: Record<string, unknown>, stepUpToken?: string): Promise<WarehouseOutcome> {
  if (typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", messages: [] };
  const ref = (x: unknown) => (x === null || x === "" ? null : isUuid(x) ? x : undefined);
  let process: string;
  let body: Record<string, unknown>;
  if (op === "create") {
    process = "warehouse.putaway_rule.create";
    body = defined({ warehouseId: ref(input.warehouseId), categoryId: ref(input.categoryId), locationId: ref(input.locationId), priority: num(input.priority) });
  } else if (op === "update" && isUuid(input.id)) {
    process = "warehouse.putaway_rule.update";
    body = defined({ id: input.id, categoryId: ref(input.categoryId), locationId: ref(input.locationId) ?? undefined, priority: num(input.priority) });
  } else if (op === "delete" && isUuid(input.id)) {
    process = "warehouse.putaway_rule.delete";
    body = { id: input.id };
  } else return { ok: false, code: "invalid_input", messages: [] };
  try {
    const out = (await runProcess(processDeps(), await caller(stepUpToken), process, body)) as { id?: unknown } | null;
    return { ok: true, ...(out && typeof out.id === "string" ? { id: out.id } : {}) };
  } catch (error) {
    return stepRefusal(error);
  }
}

/** Ubicar recibidos: the suggestion of a receipt (warehouse.putaway.suggest, consult), with the names of what it names, as the caller. */
export async function suggestPutawayAction(movementId: string): Promise<{ ok: true; listed: boolean; reason?: string; lines: SuggestionLineView[] } | { ok: false; code: string; messages: string[] }> {
  if (!isUuid(movementId)) return { ok: false, code: "invalid_input", messages: [] };
  try {
    const who = await caller();
    const out = (await runProcess(processDeps(), who, "warehouse.putaway.suggest", { movementId })) as {
      listed: boolean; reason?: string;
      lines: { productId: string; lotId: string | null; serialId: string | null; qty: number; fromLocationId: string | null; toLocationId: string | null; basis: string }[];
    };
    return { ok: true, listed: out.listed, ...(out.reason ? { reason: out.reason } : {}), lines: await labelSuggestion(who, out.lines) };
  } catch (error) {
    return stepRefusal(error);
  }
}

/** Ubicar recibidos: «Confirmar ubicación» (warehouse.putaway.confirm); inventory relocates the stock (inventory.relocation.post). */
export async function confirmPutawayAction(movementId: string, lines: unknown, stepUpToken?: string): Promise<WarehouseOutcome> {
  if (!isUuid(movementId) || !Array.isArray(lines) || lines.length === 0) return { ok: false, code: "invalid_input", messages: [] };
  const rows = lines.map((v) => {
    const l = (v ?? {}) as Record<string, unknown>;
    const qty = num(l.qty);
    if (!isUuid(l.productId) || !isUuid(l.toLocationId) || qty === undefined) return null;
    const ref = (x: unknown) => (x === null || x === undefined ? null : isUuid(x) ? x : undefined);
    const fromLocationId = ref(l.fromLocationId);
    if (fromLocationId === undefined) return null;
    return defined({ productId: l.productId, lotId: ref(l.lotId), serialId: ref(l.serialId), qty, fromLocationId, toLocationId: l.toLocationId });
  });
  if (rows.some((r) => r === null)) return { ok: false, code: "invalid_input", messages: [] };
  try {
    await runProcess(processDeps(), await caller(stepUpToken), "warehouse.putaway.confirm", { movementId, lines: rows });
    return { ok: true, id: movementId };
  } catch (error) {
    return stepRefusal(error);
  }
}
