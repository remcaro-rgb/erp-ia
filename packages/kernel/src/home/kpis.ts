import { z } from "zod";
import { readAiUsage } from "../admin/usage";
import type { ProcessContext } from "../process/context";
import { getServiceDb } from "../db/service";
import { entitled } from "../entitlements/resolver";
import { defineProcess } from "../process/define";
import type { HomeKpiProvider, Kpi } from "../registry/types";
import { dailySeries, SERIES_DAYS } from "./series";

// The home screen's KPIs (design §19a, Task 20). Modules register `HomeKpiProvider`s (core: parties and products,
// support: open tickets; sales KPIs arrive in plan 2); `kernel.home.kpis` runs the ones the company is entitled to,
// as the caller, so row security, the party scope and field masks decide the numbers. The kernel contributes the AI
// usage KPI, which reads its own tables.

export const HOME_FEATURE = "kernel.home";

export const kpiSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.number().finite(),
  unit: z.enum(["count", "percent", "tokens", "money"]),
  progress: z.number().min(0).max(1).optional(),
  tone: z.enum(["default", "warn"]).optional(),
  detail: z.object({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])) }).optional(),
  series: z.array(z.number().finite().min(0)).length(SERIES_DAYS).optional(),
});

/** At 80 % of the monthly token allowance the card asks for attention. */
const AI_WARN_AT = 0.8;

/**
 * AI usage of the month (rule 27). The company admin sees the company's tokens against the allowance; anyone else
 * sees their own tokens (the usage view shows them only their rows, so a share of the company's allowance would mislead).
 */
export const aiTokensKpi: HomeKpiProvider = {
  id: "kernel.ai_tokens",
  feature: HOME_FEATURE,
  compute: async (ctx) => {
    const usage = await readAiUsage(ctx.tx, ctx.companyId);
    const [who] = await ctx.tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
    const label = "home.kpi.kernel_ai_tokens.label";
    // The trend is the tokens per day whatever the number says (a share, or the caller's own): the view shows each caller their rows.
    const series = await dailySeries(ctx.tx, ctx.companyId, "kernel.v_llm_usage", "tokens");
    if (!who!.admin) {
      return [{ id: "kernel.ai_tokens", label, value: usage.used, unit: "tokens", detail: { key: "home.kpi.kernel_ai_tokens.own", params: {} }, series }];
    }
    if (usage.limit === null || usage.limit <= 0) {
      return [{ id: "kernel.ai_tokens", label, value: usage.used, unit: "tokens", detail: { key: "home.kpi.kernel_ai_tokens.no_cap", params: {} }, series }];
    }
    const share = usage.used / usage.limit;
    return [
      {
        id: "kernel.ai_tokens",
        label,
        value: Math.round(share * 100),
        unit: "percent",
        progress: Math.min(share, 1),
        ...(share >= AI_WARN_AT ? { tone: "warn" as const } : {}),
        detail: { key: "home.kpi.kernel_ai_tokens.company", params: { used: usage.used, limit: usage.limit } },
        series,
      },
    ];
  },
};

export const KERNEL_KPI_PROVIDERS: HomeKpiProvider[] = [aiTokensKpi];

/** Whether the company may use the provider's feature. The kernel is the platform: its features need no entitlement. */
async function featureAvailable(companyId: string, feature: string): Promise<boolean> {
  if (feature.split(".")[0] === "kernel") return true;
  return entitled(getServiceDb(), companyId, `feature:${feature}`);
}

/** The providers the caller gets: entitled feature, and a role allowed to run the consult the provider names. */
async function availableProviders(ctx: ProcessContext): Promise<HomeKpiProvider[]> {
  const providers = ctx.registry.kpiProviders();
  const features = [...new Set(providers.map((p) => p.feature))];
  const entitledFeatures = new Set((await Promise.all(features.map(async (f) => ((await featureAvailable(ctx.companyId, f)) ? f : null)))).filter((f): f is string => f !== null));
  const consults = [...new Set(providers.flatMap((p) => (p.consult ? [p.consult] : [])))];
  const allowed = new Set<string>();
  if (consults.length > 0) {
    const rows = await ctx.tx<{ id: string; allowed: boolean }[]>`select p.id, kernel.can_run_process(p.id) as allowed from unnest(${consults}::text[]) as p(id)`;
    for (const row of rows) if (row.allowed) allowed.add(row.id);
  }
  const available = providers.filter((p) => entitledFeatures.has(p.feature) && (p.consult === undefined || allowed.has(p.consult)));
  // The modules' business numbers first, in load order; the platform's own (AI usage) after them.
  const isPlatform = (p: HomeKpiProvider) => p.id.split(".")[0] === "kernel";
  return [...available.filter((p) => !isPlatform(p)), ...available.filter(isPlatform)];
}

export const homeKpis = defineProcess({
  id: "kernel.home.kpis",
  module: "kernel",
  kind: "consult",
  feature: HOME_FEATURE,
  description: "Consulta los indicadores de la pantalla de inicio: los de cada módulo que la empresa tiene contratado, calculados con los permisos del usuario",
  input: z.object({}),
  output: z.object({ kpis: z.array(kpiSchema) }),
  handler: async (ctx) => {
    const kpis: Kpi[] = [];
    for (const provider of await availableProviders(ctx)) {
      try {
        // A savepoint: a provider whose query fails must not abort the transaction the other KPIs (and the audit row) use.
        kpis.push(...(await ctx.tx.savepoint((tx) => provider.compute({ ...ctx, tx }))));
      } catch (error) {
        console.error(`home KPI provider ${provider.id} failed`, error);
      }
    }
    return { kpis };
  },
});
