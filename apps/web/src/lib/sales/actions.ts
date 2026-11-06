"use server";

import { runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { clickKey as key, defined, num, text } from "@/lib/records/step-helpers";
import { stepRefusal as refusal } from "@/lib/records/step-refusal";
import { processDeps } from "@/lib/server/runtime";
import { SALES_STEPS } from "./record";

// The CRM and sales screens' server side (plan 2B Task 14b, rule 1): every button runs a registered process as the session's user, with
// the step-up token when the user just verified one (rule 15). The process comes from an allowlist keyed by entity and step name
// (SALES_STEPS); the client never names it, and the server builds each process's input from the fields that step takes. A refusal comes
// back as data for the screen (the readiness gate's reasons among them, rule 10); `step_up_required` makes it ask for the code and run the
// same step again.

export type SalesStepOutcome =
  | { ok: true; created?: { entity: string; id: string; number: string | null } }
  | { ok: false; code: string; messages: string[] };

/** What each step's process takes, built from the record and the fields the step's screen sends. */
function stepInput(process: string, id: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (process) {
    case "sales.order.from_quote":
      return defined({ quoteId: id, warehouseId: text(input.warehouseId), deliveryDate: text(input.deliveryDate) });
    case "sales.order.confirm":
    case "sales.delivery.ship":
    case "sales.return.receive":
      return defined({ id, idempotencyKey: key(input.idempotencyKey) });
    case "sales.order.cancel":
      return { id, reason: text(input.reason) ?? "" };
    case "sales.delivery.create":
      return { orderId: id };
    case "sales.return.create":
      return { deliveryId: id, reason: text(input.reason) ?? "" };
    case "crm.lead.convert":
      return defined({
        id,
        personType: text(input.personType),
        documentType: text(input.documentType),
        documentNumber: text(input.documentNumber),
        firstName: text(input.firstName),
        firstSurname: text(input.firstSurname),
        secondSurname: text(input.secondSurname),
        otherNames: text(input.otherNames),
        opportunityTitle: text(input.opportunityTitle),
        amount: num(input.amount),
        pipelineId: text(input.pipelineId),
        expectedClose: text(input.expectedClose),
      });
    case "crm.opportunity.stage_move":
      return defined({ id, stageId: text(input.stageId), lostReason: text(input.lostReason) });
    default:
      return { id };
  }
}

/** The record a creating step opens next. */
const CREATES: Readonly<Record<string, string>> = {
  "sales.order.from_quote": "sales.order",
  "sales.delivery.create": "sales.delivery",
  "sales.return.create": "sales.return",
};

/** A step of a stored cotización, pedido, entrega, devolución, prospecto or oportunidad (SALES_STEPS). */
export async function runSalesStepAction(entity: string, step: string, recordId: string, input: Record<string, unknown> = {}, stepUpToken?: string): Promise<SalesStepOutcome> {
  const steps = Object.hasOwn(SALES_STEPS, entity) ? SALES_STEPS[entity]! : null;
  const process = steps && Object.hasOwn(steps, step) ? steps[step]! : null;
  if (!process || typeof recordId !== "string" || !recordId || typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", messages: [] };
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

/** The parámetros pages of CRM and Ventas and a customer's condiciones comerciales: each saves through its own process. */
const SETTINGS: Readonly<Record<string, { process: string; fields: readonly string[] }>> = {
  crm: { process: "crm.settings.update", fields: ["quoteApprovalDiscountPct", "quoteValidityDays"] },
  sales: { process: "sales.settings.update", fields: ["defaultPriceListId", "orderApprovalDiscountPct"] },
  customer_terms: { process: "sales.customer_terms.set", fields: ["partyId", "priceListId", "discountPct", "creditLimit", "notes"] },
};

export async function saveSalesSettingsAction(kind: string, input: Record<string, unknown>, stepUpToken?: string): Promise<{ ok: true } | { ok: false; code: string; messages: string[] }> {
  const setting = Object.hasOwn(SETTINGS, kind) ? SETTINGS[kind]! : null;
  if (!setting || typeof input !== "object" || input === null) return { ok: false, code: "invalid_input", messages: [] };
  const body = Object.fromEntries(setting.fields.filter((f) => Object.hasOwn(input, f)).map((f) => [f, input[f]]));
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    await runProcess(processDeps(), caller, setting.process, body);
    return { ok: true };
  } catch (error) {
    const outcome = await refusal(error);
    return outcome.ok ? { ok: false, code: "unknown", messages: [] } : outcome;
  }
}
