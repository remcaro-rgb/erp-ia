import "server-only";
import { gridPageAccess, runProcess, type Caller } from "@erp/kernel";
import { gridEntity } from "@/lib/grid/access";
import { stepRefusal as refusal } from "@/lib/records/step-refusal";
import { processDeps } from "@/lib/server/runtime";

// «Aplicar a facturas»' list of the customer's advances (payments.advance.open; plan 2B.2 Task 36, R36-10). The process reads the receipts through
// their masked view and the applied figure from a definer function, and answers `forbidden` itself when the caller does not see the fields it is
// made of. The screen checks the same fields first, in `gridPageAccess` like «Registrar pago» does (`openInvoicesFor`, rule 14): a masked or hidden
// field is a typed `forbidden`, never a list with the figures guessed or blanked, and a masked field never filters or sorts.

/** The receipt fields the list shows or is filtered by (the customer, the state), and the applications' amount the applied figure is made of. */
export const OPEN_ADVANCES_FIELDS = ["number", "date", "advance", "party_id", "status"] as const;
const LINE_FIELDS = ["amount"] as const;

export interface OpenAdvance {
  receiptId: string;
  number: string | null;
  date: string | null;
  method: string | null;
  advance: number;
  applied: number;
  remaining: number;
}

export type OpenAdvancesOutcome = { ok: true; advances: OpenAdvance[] } | { ok: false; code: string; messages: string[] };

export async function openAdvancesFor(caller: Caller, partyId: string): Promise<OpenAdvancesOutcome> {
  const deps = processDeps();
  const receipt = gridEntity(deps.registry, "payments.receipt");
  const line = gridEntity(deps.registry, "payments.advance_application_line");
  if (!receipt || !line) return { ok: false, code: "forbidden", messages: [] };
  const [receiptAccess, lineAccess] = await Promise.all([gridPageAccess(deps.sql, caller.claims, receipt), gridPageAccess(deps.sql, caller.claims, line)]);
  const hidden =
    OPEN_ADVANCES_FIELDS.some((f) => (receiptAccess.modes[f] ?? "visible") !== "visible") || LINE_FIELDS.some((f) => (lineAccess.modes[f] ?? "visible") !== "visible");
  if (hidden) return { ok: false, code: "forbidden", messages: [] };
  try {
    const result = (await runProcess(deps, caller, "payments.advance.open", { partyId })) as { advances: OpenAdvance[] };
    return { ok: true, advances: result.advances };
  } catch (error) {
    return refusal(error);
  }
}
