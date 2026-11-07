import { defineProcess, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { POSTING_MODES } from "../posting/mode";
import { defined, invalid, settingsOf } from "./common";
import { idOutput, id } from "./schemas";

// Configuración contable (accounting design §4.11): one row per company, created by chart.seed, edited under step-up.

export const settingsUpdate = defineProcess({
  id: "accounting.settings.update",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description: "Cambia la configuración contable: dimensiones en uso, aprobación de comprobantes manuales, tolerancia de redondeo y fuente manual",
  input: z
    .object({
      useOpenAuxiliaries: z.boolean(),
      useItems: z.boolean(),
      useBusinessUnits: z.boolean(),
      requireApprovalOnManual: z.boolean(),
      requireAttachmentOnManual: z.boolean(),
      roundingTolerance: z.number().min(0).max(1_000_000),
      manualJournalId: id,
      niifGroup: z.enum(["1", "2", "3"]),
      ruleStaleDays: z.number().int().min(1).max(3650),
    })
    .partial()
    .strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const current = await settingsOf(ctx);
    if (!current) throw invalid("accounting is not configured", "Primero configura la contabilidad (Configurar contabilidad)");
    if (input.manualJournalId !== undefined) {
      const [journal] = await ctx.tx<{ is_active: boolean; manual_entries: boolean }[]>`
        select is_active, manual_entries from accounting.journals where id = ${input.manualJournalId} and company_id = ${ctx.companyId}`;
      if (!journal) throw invalid(`journal ${input.manualJournalId} not found`, "La fuente indicada no existe");
      if (!journal.is_active || !journal.manual_entries) throw invalid("manual journal must take manual entries", "La fuente manual debe estar activa y aceptar comprobantes manuales");
    }
    const set = defined({
      use_open_auxiliaries: input.useOpenAuxiliaries,
      use_items: input.useItems,
      use_business_units: input.useBusinessUnits,
      require_approval_on_manual: input.requireApprovalOnManual,
      require_attachment_on_manual: input.requireAttachmentOnManual,
      rounding_tolerance: input.roundingTolerance,
      manual_journal_id: input.manualJournalId,
      niif_group: input.niifGroup,
      rule_stale_days: input.ruleStaleDays,
    });
    if (Object.keys(set).length > 0) await ctx.tx`update accounting.settings set ${ctx.tx(set)} where id = ${current.id}`;
    return { id: current.id };
  },
});

/**
 * What awaits the ledger (plan 2B Task 33, R33-6, R33-9): documents whose posting event the consumer has not delivered yet (published reader
 * `accounting.pending_postings`, state `queued`, or `dead` when the dispatcher dead-lettered it first; one per source document) and failures in the retry queue (`pending`). Both can be non-zero
 * in either mode: a queue left over after switching back to inline strict keeps being posted by the consumer.
 */
async function pendingCounts(ctx: ProcessContext): Promise<{ pendingDocuments: number; pendingFailures: number }> {
  const [docs] = await ctx.tx<{ n: number }[]>`select count(distinct source_id)::int as n from accounting.pending_postings() where state in ('queued', 'dead')`;
  const [failures] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from accounting.posting_failures where company_id = ${ctx.companyId} and status = 'pending'`;
  return { pendingDocuments: docs!.n, pendingFailures: failures!.n };
}

// Plan 2B Task 33 (owner decisions item 5, R33-5): the only way to change the posting mode. One column of the settings row: switching never
// rewrites anything (entries posted stay, queued events are posted by the consumer under either mode, failures stay in the retry queue); the
// row audit keeps posting_mode's before and after. The table's trigger refuses any other user session (migration 0128).
export const postingModeSet = defineProcess({
  id: "accounting.posting_mode.set",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description:
    "Cambia el modo de contabilización de los documentos: inmediata y estricta (el documento y su asiento en la misma operación) o asíncrona con reintentos (el documento se guarda y su asiento se registra después)",
  input: z.object({ mode: z.enum(POSTING_MODES) }).strict(),
  output: z.object({ id: z.string(), mode: z.enum(POSTING_MODES), previous: z.enum(POSTING_MODES), pendingFailures: z.number().int(), pendingDocuments: z.number().int() }),
  handler: async (ctx, { mode }) => {
    if (!(await settingsOf(ctx))) throw invalid("accounting is not configured", "Primero configura la contabilidad (Configurar contabilidad)");
    // The row's lock: two switches at once apply one after the other, each answering the mode it replaced.
    const [row] = await ctx.tx<{ id: string; posting_mode: (typeof POSTING_MODES)[number] }[]>`
      select id, posting_mode from accounting.settings where company_id = ${ctx.companyId} for update`;
    if (row!.posting_mode !== mode) await ctx.tx`update accounting.settings set posting_mode = ${mode} where id = ${row!.id}`;
    return { id: row!.id, mode, previous: row!.posting_mode, ...(await pendingCounts(ctx)) };
  },
});

export const settingsConsult = defineProcess({
  id: "accounting.settings.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.posting",
  description: "Consulta la configuración contable de la empresa (valores por defecto mientras no se haya configurado)",
  input: z.object({}),
  output: z.looseObject({ configured: z.boolean() }),
  handler: async (ctx) => {
    const settings = await settingsOf(ctx);
    if (!settings) {
      return {
        configured: false, ledgerStartsOn: null, roundingTolerance: 1, manualJournalId: null, requireAttachmentOnManual: false, niifGroup: "2",
        requireApprovalOnManual: false, useOpenAuxiliaries: false, useItems: false, useBusinessUnits: false, ruleStaleDays: 30, skippedEvents: 0,
        postingMode: "inline_strict", pendingDocuments: 0, pendingFailures: 0,
      };
    }
    // Events acknowledged without posting because they predate the start of the ledger (Reglas contables → Configuración, §5.1).
    const [skipped] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from accounting.skipped_events where company_id = ${ctx.companyId}`;
    return { configured: true, ...settings, skippedEvents: skipped!.n, ...(await pendingCounts(ctx)) };
  },
});

export const SETTINGS_PROCESSES = [settingsUpdate, postingModeSet, settingsConsult];
