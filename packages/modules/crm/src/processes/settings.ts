import { defineProcess, type ProcessContext } from "@erp/kernel";
import { z } from "zod";

// Parámetros de CRM (plan 2B Task 12): the line discount above which a cotización waits for approval (none: no cotización does) and the
// default validity of a new cotización in days. A company without a row: no threshold, 30 days.

const FEATURE = "crm.settings";
const DEFAULT_VALIDITY_DAYS = 30;

export interface QuoteSettings {
  approvalDiscountPct: number | null;
  validityDays: number;
}

/** The company's quote settings (defaults when it has none), as the caller reads them. */
export async function quoteSettings(ctx: ProcessContext): Promise<QuoteSettings> {
  const [row] = await ctx.tx<{ quote_approval_discount_pct: string | null; quote_validity_days: number | null }[]>`
    select quote_approval_discount_pct::text, quote_validity_days from crm.settings where company_id = ${ctx.companyId}`;
  return {
    approvalDiscountPct: row?.quote_approval_discount_pct === null || row?.quote_approval_discount_pct === undefined ? null : Number(row.quote_approval_discount_pct),
    validityDays: row?.quote_validity_days ?? DEFAULT_VALIDITY_DAYS,
  };
}

const percent = z.number().finite().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
const settingsOutput = z.object({ id: z.string(), quoteApprovalDiscountPct: z.number().nullable(), quoteValidityDays: z.number().int() });

export const settingsUpdate = defineProcess({
  id: "crm.settings.update",
  module: "crm",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  description:
    "Cambia los parámetros de las cotizaciones: el descuento por línea por encima del cual una cotización necesita aprobación (vacío: ninguna) y los días de vigencia de una cotización nueva",
  input: z.object({
    quoteApprovalDiscountPct: percent.nullable().optional(),
    quoteValidityDays: z.number().int().min(1).max(365).optional(),
  }).strict(),
  output: settingsOutput,
  handler: async (ctx, input) => {
    const current = await quoteSettings(ctx);
    const next = {
      quote_approval_discount_pct: input.quoteApprovalDiscountPct === undefined ? current.approvalDiscountPct : input.quoteApprovalDiscountPct,
      quote_validity_days: input.quoteValidityDays ?? current.validityDays,
    };
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into crm.settings ${ctx.tx({ company_id: ctx.companyId, ...next })}
      on conflict (company_id) do update set quote_approval_discount_pct = excluded.quote_approval_discount_pct, quote_validity_days = excluded.quote_validity_days
      returning id`;
    return { id: row!.id, quoteApprovalDiscountPct: next.quote_approval_discount_pct, quoteValidityDays: next.quote_validity_days };
  },
});

export const settingsConsult = defineProcess({
  id: "crm.settings.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta los parámetros de las cotizaciones de la empresa (tope de descuento sin aprobación y días de vigencia)",
  input: z.object({}).strict(),
  output: z.looseObject({ configured: z.boolean() }),
  handler: async (ctx) => {
    const [row] = await ctx.tx`select * from crm.v_settings where company_id = ${ctx.companyId}`;
    return row ? { ...row, configured: true } : { configured: false, quote_approval_discount_pct: null, quote_validity_days: DEFAULT_VALIDITY_DAYS };
  },
});

export const SETTINGS_PROCESSES = [settingsUpdate, settingsConsult];
