"use server";

import { runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { clickKey, defined, isUuid, text } from "@/lib/records/step-helpers";
import { stepRefusal as refusal } from "@/lib/records/step-refusal";
import { processDeps } from "@/lib/server/runtime";
import { openInvoicesFor, type OpenInvoicesOutcome } from "./open-invoices";
import { PAYMENTS_STEPS } from "./record";

// The payments screens' server side (plan 2B Task 24b, rule 1): every button runs a registered process as the session's user, with the
// step-up token when the user just verified one (rule 15: «Anular recibo», «Deshacer aplicación»). The process comes from an allowlist keyed by entity and step
// name (PAYMENTS_STEPS); the client never names it, and the server builds each process's input from the fields that step takes. «Registrar
// pago» itself is the receipt's create process (saveRecordAction, the entity's `create`); its list of the customer's open invoices is
// payments.payment.open_invoices. A refusal comes back as data for the screen; `step_up_required` makes it ask for the code.

export type PaymentsStepOutcome = { ok: true } | { ok: false; code: string; messages: string[] };

/** «Registrar pago»: the customer's issued invoices with what is open and whether this receipt can pay each (and why not). Refuses `forbidden` when the caller may not see the invoices' amounts (Ruling R40-2). */
export async function openInvoicesAction(partyId: unknown, date: unknown, currency?: unknown): Promise<OpenInvoicesOutcome> {
  if (!isUuid(partyId)) return { ok: false, code: "invalid_input", messages: [] };
  return openInvoicesFor(await requireCaller(), partyId, date, currency);
}

/**
 * «Aplicar anticipo» (payments.advance.apply, plan 2B.2 Task 36): applies the advance of a receipt to the customer's invoices. No step-up (as the
 * receipt's creation). The input is rebuilt here from the fields the panel sends (the client names no process nor any other key): the customer,
 * the lines (receipt, invoice, amount) and the panel's idempotency key; the server validates the balances and the invoices again (rule 1).
 */
export async function applyAdvanceAction(input: unknown): Promise<PaymentsStepOutcome> {
  if (typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", messages: [] };
  const { partyId, lines, idempotencyKey } = input as Record<string, unknown>;
  if (!isUuid(partyId) || !Array.isArray(lines) || lines.length === 0 || lines.length > 100) return { ok: false, code: "invalid_input", messages: [] };
  const clean: { receiptId: string; invoiceId: string; amount: number }[] = [];
  for (const line of lines) {
    const l = (typeof line === "object" && line !== null ? line : {}) as Record<string, unknown>;
    if (!isUuid(l.receiptId) || !isUuid(l.invoiceId) || typeof l.amount !== "number" || !Number.isFinite(l.amount)) return { ok: false, code: "invalid_input", messages: [] };
    clean.push({ receiptId: l.receiptId, invoiceId: l.invoiceId, amount: l.amount });
  }
  try {
    await runProcess(processDeps(), await requireCaller(), "payments.advance.apply", defined({ partyId, lines: clean, idempotencyKey: clickKey(idempotencyKey) }));
    return { ok: true };
  } catch (error) {
    return refusal(error);
  }
}

/** What each step's process takes, built from the record and the fields the step's screen sends. */
function stepInput(process: string, id: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (process) {
    case "payments.payment.void":
      return defined({ id, reason: text(input.reason) ?? "", expectedUpdatedAt: text(input.expectedUpdatedAt) });
    case "payments.advance.undo":
      return defined({ id, reason: text(input.reason) ?? "", expectedUpdatedAt: text(input.expectedUpdatedAt) });
    default:
      return { id };
  }
}

/** A step of a stored receipt (PAYMENTS_STEPS). */
export async function runPaymentsStepAction(entity: string, step: string, recordId: string, input: Record<string, unknown> = {}, stepUpToken?: string): Promise<PaymentsStepOutcome> {
  const steps = Object.hasOwn(PAYMENTS_STEPS, entity) ? PAYMENTS_STEPS[entity]! : null;
  const process = steps && Object.hasOwn(steps, step) ? steps[step]! : null;
  if (!process || typeof recordId !== "string" || !isUuid(recordId) || typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", messages: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    await runProcess(processDeps(), caller, process, stepInput(process, recordId, input));
    return { ok: true };
  } catch (error) {
    return refusal(error);
  }
}
