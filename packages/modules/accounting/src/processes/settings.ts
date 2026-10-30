import { defineProcess } from "@erp/kernel";
import { z } from "zod";
import { defined, invalid, settingsOf } from "./common";
import { idOutput, id } from "./schemas";

// Configuración contable (accounting design §4.11): one row per company, created by chart.seed, edited under step-up.

export const settingsUpdate = defineProcess({
  id: "accounting.settings.update",
  module: "accounting",
  kind: "update",
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
    });
    if (Object.keys(set).length > 0) await ctx.tx`update accounting.settings set ${ctx.tx(set)} where id = ${current.id}`;
    return { id: current.id };
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
        requireApprovalOnManual: false, useOpenAuxiliaries: false, useItems: false, useBusinessUnits: false,
      };
    }
    return { configured: true, ...settings };
  },
});

export const SETTINGS_PROCESSES = [settingsUpdate, settingsConsult];
