import { z } from "zod";
import { readAiUsage } from "../admin/usage";
import type { ProcessContext } from "../process/context";
import { getServiceDb } from "../db/service";
import { entitled } from "../entitlements/resolver";
import { defineProcess } from "../process/define";
import type { Chart, HomeChartProvider, HomeKpiProvider, Kpi } from "../registry/types";
import { dailyPoints, dailySeries, SERIES_DAYS } from "./series";

// The home screen's KPIs (design §19a, Task 20). Modules register `HomeKpiProvider`s (core: parties and products,
// support: open tickets; sales KPIs arrive in plan 2); `kernel.home.kpis` runs the ones the company is entitled to,
// as the caller, so row security, the party scope and field masks decide the numbers. The kernel contributes the AI
// usage KPI, which reads its own tables.

export const HOME_FEATURE = "kernel.home";

export const kpiSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.number().finite(),
  unit: z.enum(["count", "percent", "tokens", "money", "ratio"]),
  progress: z.number().min(0).max(1).optional(),
  tone: z.enum(["default", "warn"]).optional(),
  detail: z.object({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])) }).optional(),
  series: z.array(z.number().finite().min(0)).length(SERIES_DAYS).optional(),
  /** An address of the app (never another site): where the card leads. */
  href: z.string().regex(/^\/(?!\/)/).optional(),
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
      return [{ id: "kernel.ai_tokens", label, value: usage.used, unit: "tokens", href: "/admin/ai-usage", detail: { key: "home.kpi.kernel_ai_tokens.no_cap", params: {} }, series }];
    }
    const share = usage.used / usage.limit;
    return [
      {
        id: "kernel.ai_tokens",
        label,
        href: "/admin/ai-usage",
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

export const chartSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["bar", "line"]),
  unit: z.enum(["count", "percent", "tokens", "money"]),
  series: z.array(z.object({ label: z.string(), points: z.array(z.object({ label: z.string(), value: z.number().finite() })).max(60) })).max(6),
  i18n: z.boolean().optional(),
  href: z.string().regex(/^\/(?!\/)/).optional(),
});

/** What the "Personalizar página de inicio" dialog lists: every KPI and chart the caller could see, with the keys of its name and its one-line description. */
export const catalogItemSchema = z.object({ id: z.string(), kind: z.enum(["kpi", "chart"]), module: z.string(), label: z.string(), description: z.string() });
export type CatalogItem = z.infer<typeof catalogItemSchema>;

/** The i18n key of a provider's catalogue text: `home.catalog.accounting_result_month.label` / `.description`. */
export const catalogKey = (id: string, part: "label" | "description"): string => `home.catalog.${id.replace(/\./g, "_")}.${part}`;

/** The user preference listing the items the user switched off (`{ value: string[], savedAt }`): new items start on. */
export const HOME_HIDDEN_PREF = "home_hidden";

/** Usuarios activos: the members of the company who can sign in, out of all of them. For whoever may consult users. */
export const activeUsersKpi: HomeKpiProvider = {
  id: "kernel.active_users",
  feature: "kernel.users",
  consult: "kernel.user.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ total: number; known: number; active: number; mfa: number }[]>`
      select count(*)::int as total, count(is_active)::int as known, count(*) filter (where is_active)::int as active,
             count(*) filter (where is_active and mfa_required)::int as mfa
      from kernel.v_users`;
    const { total, known, active, mfa } = row!;
    // `is_active` masked reads as null on every row: the card then counts every member it can see.
    const visible = total === 0 || known === total;
    return [
      {
        id: "kernel.active_users",
        href: "/admin/users",
        label: "home.kpi.kernel_users.label",
        value: visible ? active : total,
        unit: "count",
        ...(visible && total > 0 ? { progress: active / total } : {}),
        detail: { key: "home.kpi.kernel_users.detail", params: { total, mfa } },
      },
    ];
  },
};

/** Acciones auditadas: what the audit trail recorded in the last 24 hours (the company's own activity). */
export const auditActivityKpi: HomeKpiProvider = {
  id: "kernel.audit_24h",
  feature: "kernel.audit",
  consult: "kernel.audit.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ total: number; ai: number }[]>`
      select count(*)::int as total, count(*) filter (where origin = 'ai')::int as ai
      from kernel.v_audit_entries where company_id = ${ctx.companyId} and occurred_at >= now() - interval '24 hours'`;
    const series = await dailySeries(ctx.tx, ctx.companyId, "kernel.v_audit_entries", "count", "occurred_at");
    return [{ id: "kernel.audit_24h", href: "/admin/audit", label: "home.kpi.kernel_audit.label", value: row!.total, unit: "count", detail: { key: "home.kpi.kernel_audit.detail", params: { ai: row!.ai } }, series }];
  },
};

export const KERNEL_KPI_PROVIDERS: HomeKpiProvider[] = [aiTokensKpi, activeUsersKpi, auditActivityKpi];

const shortDay = (iso: string) => iso.slice(5);

/** Tokens per day: the usage of the last 14 days (the company's for an admin, the caller's own for anyone else: the view decides). */
export const aiTokensChart: HomeChartProvider = {
  id: "kernel.ai_tokens_daily",
  feature: HOME_FEATURE,
  compute: async (ctx) => {
    const points = await dailyPoints(ctx.tx, ctx.companyId, "kernel.v_llm_usage", "tokens");
    return [{ id: "kernel.ai_tokens_daily", label: "home.chart.kernel_ai_tokens_daily.label", kind: "line", unit: "tokens", href: "/admin/ai-usage", series: [{ label: "home.chart.series.tokens", points: points.map((p) => ({ label: shortDay(p.day), value: p.value })) }] }];
  },
};

/** Audit entries per day, split between what people did and what the assistant did. */
export const auditActivityChart: HomeChartProvider = {
  id: "kernel.audit_daily",
  feature: "kernel.audit",
  consult: "kernel.audit.consult",
  compute: async (ctx) => {
    const points = await dailyPoints(ctx.tx, ctx.companyId, "kernel.v_audit_entries", "count", "occurred_at");
    return [{ id: "kernel.audit_daily", label: "home.chart.kernel_audit_daily.label", kind: "line", unit: "count", href: "/admin/audit", series: [{ label: "home.chart.series.actions", points: points.map((p) => ({ label: shortDay(p.day), value: p.value })) }] }];
  },
};

export const KERNEL_CHART_PROVIDERS: HomeChartProvider[] = [aiTokensChart, auditActivityChart];

/** Whether the company may use the provider's feature. The kernel is the platform: its features need no entitlement. */
async function featureAvailable(companyId: string, feature: string): Promise<boolean> {
  if (feature.split(".")[0] === "kernel") return true;
  return entitled(getServiceDb(), companyId, `feature:${feature}`);
}

/** The providers the caller gets: entitled feature, and a role allowed to run the consult the provider names. */
async function availableProviders<T extends { id: string; feature: string; consult?: string }>(ctx: ProcessContext, providers: T[]): Promise<T[]> {
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
  const isPlatform = (p: T) => p.id.split(".")[0] === "kernel";
  return [...available.filter((p) => !isPlatform(p)), ...available.filter(isPlatform)];
}

/** The items the caller switched off on their Inicio pages. */
async function hiddenItems(ctx: ProcessContext): Promise<Set<string>> {
  const [row] = await ctx.tx<{ value: unknown }[]>`
    select value from kernel.user_prefs where user_id = ${ctx.userId} and company_id = ${ctx.companyId} and key = ${HOME_HIDDEN_PREF}`;
  const stored = row?.value as { value?: unknown } | unknown[] | null | undefined;
  const list = Array.isArray(stored) ? stored : stored && typeof stored === "object" && "value" in stored ? stored.value : [];
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
}

export const homeKpis = defineProcess({
  id: "kernel.home.kpis",
  module: "kernel",
  kind: "consult",
  feature: HOME_FEATURE,
  description:
    "Consulta los indicadores y gráficos de Inicio: los de cada módulo que la empresa tiene contratado (o solo los de un módulo), calculados con los permisos del usuario y sin los que el usuario apagó en Personalizar página de inicio",
  input: z.object({ module: z.string().regex(/^[a-z][a-z0-9_]*$/).optional() }),
  output: z.object({ kpis: z.array(kpiSchema), charts: z.array(chartSchema), catalog: z.array(catalogItemSchema) }),
  handler: async (ctx, input) => {
    const inModule = (p: { id: string }) => input.module === undefined || p.id.split(".")[0] === input.module;
    const kpiProviders = await availableProviders(ctx, ctx.registry.kpiProviders().filter(inModule));
    // The charts live on the module pages: the company-wide Inicio shows indicators only.
    const chartProviders = input.module === undefined ? [] : await availableProviders(ctx, ctx.registry.chartProviders().filter(inModule));
    const hidden = await hiddenItems(ctx);
    const kpis: Kpi[] = [];
    const charts: Chart[] = [];
    // A savepoint per provider: one whose query fails must not abort the transaction the others (and the audit row) use.
    for (const provider of kpiProviders.filter((p) => !hidden.has(p.id))) {
      try {
        kpis.push(...(await ctx.tx.savepoint((tx) => provider.compute({ ...ctx, tx }))));
      } catch (error) {
        console.error(`home KPI provider ${provider.id} failed`, error);
      }
    }
    for (const provider of chartProviders.filter((p) => !hidden.has(p.id))) {
      try {
        charts.push(...(await ctx.tx.savepoint((tx) => provider.compute({ ...ctx, tx }))));
      } catch (error) {
        console.error(`home chart provider ${provider.id} failed`, error);
      }
    }
    const item = (kind: CatalogItem["kind"]) => (p: { id: string }): CatalogItem => ({ id: p.id, kind, module: p.id.split(".")[0]!, label: catalogKey(p.id, "label"), description: catalogKey(p.id, "description") });
    return { kpis, charts, catalog: [...kpiProviders.map(item("kpi")), ...chartProviders.map(item("chart"))] };
  },
});
