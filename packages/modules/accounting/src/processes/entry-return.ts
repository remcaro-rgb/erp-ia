import { defineProcess, ProcessError } from "@erp/kernel";
import { z } from "zod";
import { invalid } from "./common";
import { id, idOutput } from "./schemas";

// Devolver a borrador (accounting design §5.5, owner decision OD-1 option A, main design §22.20): an approver sends a pending
// comprobante back to its creator. It changes the status in place: the lines are never read or rewritten, so an approver without
// view on a restricted account can return an entry that holds it, and the audit shows one row on the entry and none on the lines.

export const entryReturnToDraft = defineProcess({
  id: "accounting.entry.return_to_draft",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Devuelve a borrador un comprobante pendiente de aprobación, con el motivo opcional; las líneas quedan como están",
  input: z.object({ id, reason: z.string().trim().min(1).max(500).optional() }).strict(),
  output: idOutput,
  handler: async (ctx, { id: entryId, reason }) => {
    const [current] = await ctx.tx<{ status: string }[]>`select status from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId} for update`;
    if (!current) throw new ProcessError("not_found", `entry ${entryId} not found`);
    if (current.status !== "pending") {
      throw invalid(`entry ${entryId} is ${current.status}`, "Solo un comprobante pendiente de aprobación vuelve a borrador");
    }
    await ctx.tx`
      update accounting.entries
         set status = 'draft', submitted_by = null, submitted_at = null
             ${reason === undefined ? ctx.tx`` : ctx.tx`, extra = extra || ${ctx.tx.json({ return_reason: reason })}`}
       where id = ${entryId}`;
    return { id: entryId };
  },
});

export const ENTRY_RETURN_PROCESSES = [entryReturnToDraft];
