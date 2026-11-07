import type { Tx } from "../db/client";
import type { Registry } from "../registry";
import type { ProcessContext } from "./context";
import { ProcessError, type ProcessErrorCode } from "./errors";

// Configurable nested runs (owner decisions item 1, plan 2B Task 32, migration 0126). Per pair (parent → nested process) a company admin sets
// whether the parent's fresh TOTP covers a step-up nested process and whether a nested failure rolls everything back (default) or continues
// and queues; the nesting depth is a company parameter. No row means the fixed behaviour of Task 11 (depth 4, no coverage, roll back all).

/** The hard maximum of the nesting depth (also a check of `kernel.nested_run_settings` and the zod bound of the depth process). */
export const NESTED_HARD_MAX = 8;
/** The depth of a company that set none. */
export const DEFAULT_NESTED_DEPTH = 4;

/** The one process that may run a nested process as another parent (`ctx.runProcess(…, { asParent })`): the queue's retry. */
export const NESTED_RETRY_PROCESS = "kernel.nested_failure.retry";

export interface NestedPolicy {
  totpCovers: boolean;
  onFailure: "rollback" | "continue";
  maxDepth: number;
}

/** The policy of one nested call in the caller's active company (`kernel.nested_run_policy`), the depth clamped to 1..NESTED_HARD_MAX. */
export async function nestedPolicy(tx: Tx, parent: string, nested: string): Promise<NestedPolicy> {
  const [row] = await tx<{ totp_covers: boolean; on_failure: string; max_depth: number }[]>`select * from kernel.nested_run_policy(${parent}, ${nested})`;
  const depth = Number(row?.max_depth ?? DEFAULT_NESTED_DEPTH);
  return {
    totpCovers: row?.totp_covers === true,
    onFailure: row?.on_failure === "continue" ? "continue" : "rollback",
    maxDepth: Math.min(Math.max(Number.isFinite(depth) ? depth : DEFAULT_NESTED_DEPTH, 1), NESTED_HARD_MAX),
  };
}

/**
 * Whether `event` is one the ledger or the stock answers to, from the registry (rule 4: no module is named): the `event` of any module's
 * posting rule, or a key of any module's declared `effects` (a consumer's reaction: «Inventario: reserva existencias», «Costo de ventas»).
 */
export function ledgerOrStockEvent(registry: Registry, event: string): boolean {
  return registry.modules().some((m) => (m.postingRules ?? []).some((r) => r.event === event) || Object.prototype.hasOwnProperty.call(m.effects ?? {}, event));
}

/**
 * Why a nested process may never continue after a failure (it posts to the ledger or moves stock), or null when it may: its id is a key of
 * any module's `effects`, an event in its `emits` is a posting-rule event or an `effects` key (`ledgerOrStockEvent`), its module posts
 * (posting provider or rules), or it is an event-driven process of a module that declares effects. Over-refuses on
 * purpose (decisions item 71): a process whose event has any declared consumer effect counts. An unknown process answers null.
 */
export function ledgerOrStockReason(registry: Registry, processId: string): string | null {
  for (const m of registry.modules()) {
    if (Object.prototype.hasOwnProperty.call(m.effects ?? {}, processId)) return `${processId} has declared effects in module ${m.id}`;
  }
  let def;
  try {
    def = registry.process(processId);
  } catch {
    return null;
  }
  for (const event of def.emits ?? []) {
    if (ledgerOrStockEvent(registry, event)) return `${processId} emits ${event}, which the ledger or the stock answers to`;
  }
  // Fix round 1 (security review I1): what a process does without declaring it in `emits` (the posting engine's writes, a reservation, a
  // consumer recording a stock movement). A module that posts (a posting provider or posting rules) counts as a whole; a module that
  // declares consumer effects counts for its event-driven processes (`origins` with `event`), which are its consumers' work.
  const owner = registry.hasModule(def.module) ? registry.module(def.module) : null;
  if (owner?.postingProvider || (owner?.postingRules ?? []).length > 0) return `${processId} belongs to module ${owner!.id}, which posts to the ledger or moves stock`;
  if (owner && Object.keys(owner.effects ?? {}).length > 0 && def.origins?.includes("event")) {
    return `${processId} is an event consumer of module ${owner.id}, whose reactions are declared effects`;
  }
  return null;
}

/**
 * The codes a `continue` pair queues (R32-16): a handler failure, a SQL error (`handler_failed`) and the typed `invalid_input` and
 * `not_found`. A denial (`forbidden`, `not_entitled`, `step_up_required`, `record_forbidden`) and `idempotent_replay` always propagate.
 */
export const CONTINUABLE_CODES: ReadonlySet<ProcessErrorCode> = new Set<ProcessErrorCode>(["invalid_input", "not_found", "handler_failed"]);

const TYPED_REASON_CODES = new Set<ProcessErrorCode>(["invalid_input", "not_found", "record_forbidden", "forbidden"]);
const GENERIC_REASON: Partial<Record<ProcessErrorCode, string>> = {
  invalid_input: "Los datos de la ejecución anidada no son válidos",
  not_found: "El registro de la ejecución anidada no existe",
  handler_failed: "La ejecución anidada falló",
};
const REASON_MAX = 500;

/**
 * The reason a queued failure shows (R32-7): the typed Spanish refusal of a `ProcessError` of code `invalid_input` / `not_found` /
 * `record_forbidden` / `forbidden` (its string details, or the messages of its zod issues), else a fixed text per code; never a raw SQL or
 * stack message. At most 500 characters.
 */
export function queuedReason(error: ProcessError): string {
  let text = "";
  if (TYPED_REASON_CODES.has(error.code) && Array.isArray(error.details)) {
    text = error.details
      .map((d: unknown) => (typeof d === "string" ? d : typeof d === "object" && d !== null && typeof (d as { message?: unknown }).message === "string" ? (d as { message: string }).message : ""))
      .filter((d) => d.trim() !== "")
      .join("; ");
  }
  if (text.trim() === "") text = GENERIC_REASON[error.code] ?? "La ejecución anidada falló";
  return text.length > REASON_MAX ? text.slice(0, REASON_MAX) : text;
}

/** The error a nested run failed with, as the `ProcessError` the caller would see. */
export function asProcessError(error: unknown, processId: string): ProcessError {
  return error instanceof ProcessError ? error : new ProcessError("handler_failed", `process ${processId} failed`, { cause: error });
}

/**
 * Event observers of a run's contexts (R32-5 run-time guard): a context in a `continue` subtree reports each event it writes to the outbox,
 * so a failed nested run that already set off a ledger or stock event is never swallowed. `ctx.emit` reports itself; a kernel helper that
 * writes the outbox for a context in another way (the inline posting) calls `reportEmitted`.
 */
const EMIT_OBSERVERS = new WeakMap<ProcessContext, (event: string) => void>();

export function observeEmits(ctx: ProcessContext, observer: (event: string) => void): void {
  EMIT_OBSERVERS.set(ctx, observer);
}

export function reportEmitted(ctx: ProcessContext, event: string): void {
  EMIT_OBSERVERS.get(ctx)?.(event);
}
