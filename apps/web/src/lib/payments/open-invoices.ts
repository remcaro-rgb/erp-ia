import "server-only";
import { gridPageAccess, runProcess, type Caller } from "@erp/kernel";
import { OPEN_INVOICES_FIELDS } from "@erp/module-payments";
import type { OpenInvoice } from "@erp/ui";
import { gridEntity } from "@/lib/grid/access";
import { stepRefusal as refusal } from "@/lib/records/step-refusal";
import { processDeps } from "@/lib/server/runtime";

// «Registrar pago»'s list of the customer's open invoices (payments.payment.open_invoices). The process reads invoicing's published view
// (v_receivable_invoices), which is not masked (rule 3 publishes it for processes), and returns the invoice number, total and what is open.
// So the screen shows it only to a caller who sees those fields as they are (rule 14, plan 2B Task 40, Ruling R40-2): the number and the
// money fields the open balance is computed from. Anything less is a typed `forbidden`, never a list with the amounts guessed or blanked.
// The process refuses the same way itself (whole-branch review F-5.4), so every other channel gets the same answer; this check stays so the
// screen answers before running it.

/** The invoice fields the list shows or computes the open balance from (payments' own list): each must be visible to the caller. */
export { OPEN_INVOICES_FIELDS };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type OpenInvoicesOutcome = { ok: true; invoices: OpenInvoice[] } | { ok: false; code: string; messages: string[] };

export async function openInvoicesFor(caller: Caller, partyId: string, date?: unknown): Promise<OpenInvoicesOutcome> {
  const deps = processDeps();
  const invoice = gridEntity(deps.registry, "invoicing.invoice");
  if (!invoice) return { ok: false, code: "forbidden", messages: [] };
  const { modes } = await gridPageAccess(deps.sql, caller.claims, invoice);
  if (OPEN_INVOICES_FIELDS.some((f) => (modes[f] ?? "visible") !== "visible")) return { ok: false, code: "forbidden", messages: [] };
  try {
    const result = (await runProcess(deps, caller, "payments.payment.open_invoices", { partyId, ...(typeof date === "string" && DAY.test(date) ? { date } : {}) })) as { invoices: OpenInvoice[] };
    return { ok: true, invoices: result.invoices };
  } catch (error) {
    return refusal(error);
  }
}
