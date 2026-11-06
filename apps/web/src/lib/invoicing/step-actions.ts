"use server";

import { runProcess, withClaims } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { clickKey as key, defined, isUuid, text } from "@/lib/records/step-helpers";
import { stepRefusal as refusal } from "@/lib/records/step-refusal";
import { processDeps } from "@/lib/server/runtime";
import { INVOICING_STEPS } from "./record";

// The invoicing screens' server side (plan 2B Task 20, rule 1): every button runs a registered process as the session's user, with the
// step-up token when the user just verified one (rule 15: «Anular (nota crédito)»). The process comes from an allowlist keyed by entity
// and step name (INVOICING_STEPS); the client never names it, and the server builds each process's input from the fields that step takes.
// «Crear facturas» of «Por facturar» runs invoicing.invoice.from_orders with the pedidos of the lines chosen. A refusal comes back as data for the
// screen (the readiness gate's reasons among them, rule 10); `step_up_required` makes it ask for the code and run the same step again.

export type InvoicingStepOutcome =
  | { ok: true; created?: { entity: string; id: string; number: string | null } }
  | { ok: false; code: string; messages: string[] };

/** A note's lines as the panel sends them: the invoice line, the quantity and, when typed, the net unit price. */
function noteLines(v: unknown): { invoiceLineId: string; qty: number; unitPrice?: number }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((l) => {
    if (!l || typeof l !== "object") return [];
    const line = l as Record<string, unknown>;
    if (typeof line.invoiceLineId !== "string" || !isUuid(line.invoiceLineId) || typeof line.qty !== "number" || !Number.isFinite(line.qty)) return [];
    return [{ invoiceLineId: line.invoiceLineId, qty: line.qty, ...(typeof line.unitPrice === "number" && Number.isFinite(line.unitPrice) ? { unitPrice: line.unitPrice } : {}) }];
  });
}

/** What each step's process takes, built from the record and the fields the step's screen sends. */
function stepInput(process: string, id: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (process) {
    case "invoicing.invoice.issue":
    case "invoicing.note.issue":
      return defined({ id, idempotencyKey: key(input.idempotencyKey) });
    case "invoicing.invoice.void":
      return defined({ id, reason: text(input.reason) ?? "", expectedUpdatedAt: text(input.expectedUpdatedAt) });
    case "invoicing.note.create":
      return { invoiceId: id, kind: input.kind === "debit" ? "debit" : "credit", concept: text(input.concept) ?? "", reason: text(input.reason) ?? "", lines: noteLines(input.lines) };
    default:
      return { id };
  }
}

/** The record a creating step opens next. */
const CREATES: Readonly<Record<string, string>> = { "invoicing.note.create": "invoicing.note" };

/** A step of a stored invoice or note (INVOICING_STEPS). */
export async function runInvoicingStepAction(entity: string, step: string, recordId: string, input: Record<string, unknown> = {}, stepUpToken?: string): Promise<InvoicingStepOutcome> {
  const steps = Object.hasOwn(INVOICING_STEPS, entity) ? INVOICING_STEPS[entity]! : null;
  const process = steps && Object.hasOwn(steps, step) ? steps[step]! : null;
  if (!process || typeof recordId !== "string" || !isUuid(recordId) || typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", messages: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    const result = (await runProcess(processDeps(), caller, process, stepInput(process, recordId, input))) as { id?: unknown; number?: unknown } | null;
    const created = CREATES[process];
    if (created && result && typeof result.id === "string") return { ok: true, created: { entity: created, id: result.id, number: typeof result.number === "string" ? result.number : null } };
    return { ok: true };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * «Crear facturas» of «Por facturar» (Task 20 fix round 1): the lines the user ticked in the grid stand for their pedidos. The server reads
 * the pedidos of those lines in the masked view as the caller (the client never names a pedido) and runs invoicing.invoice.from_orders:
 * one Borrador per customer and currency with what shipped and is left to invoice of each pedido.
 */
export async function createInvoicesFromPendingAction(lineIds: unknown): Promise<{ ok: true; invoices: { id: string; number: string | null }[] } | { ok: false; code: string; messages: string[] }> {
  const ids = Array.isArray(lineIds) ? [...new Set(lineIds.filter(isUuid))] : [];
  if (ids.length === 0 || ids.length > 500) return { ok: false, code: "invalid_input", messages: [] };
  const caller = await requireCaller();
  const deps = processDeps();
  try {
    const rows = await withClaims(deps.sql, caller.claims, (tx) => tx<{ order_id: string | null }[]>`select distinct order_id from invoicing.v_pending_lines where id = any(${ids}::uuid[])`);
    const orderIds = rows.map((r) => r.order_id).filter(isUuid);
    // A line the caller does not see (or whose pedido is masked to the role) is not invoiced from here.
    if (orderIds.length === 0 || orderIds.length !== rows.length) return { ok: false, code: "forbidden", messages: [] };
    const result = (await runProcess(deps, caller, "invoicing.invoice.from_orders", { orderIds })) as { invoices: { id: string; number: string | null }[] };
    return { ok: true, invoices: result.invoices.map((i) => ({ id: i.id, number: i.number ?? null })) };
  } catch (error) {
    return refusal(error);
  }
}
