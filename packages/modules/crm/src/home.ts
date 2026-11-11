import { kpiGridHref, type Chart, type HomeChartProvider, type HomeKpiProvider } from "@erp/kernel";

// The CRM module's cards on Inicio (plan 2B Task 26, main design §19a), from its published masked views as the caller: the owner
// isolation of oportunidades (a salesperson sees the deals they own) and the field masks decide the numbers; a masked amount is never
// guessed, the card is left out instead.

const cents = (n: number) => Math.round(n * 100) / 100;

/** Pipeline: the value of the open oportunidades (not won nor lost, not annulled); the detail counts them. */
export const pipelineKpi: HomeKpiProvider = {
  id: "crm.pipeline",
  feature: "crm.opportunities",
  consult: "crm.opportunity.consult",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ n: number; known: number; amount: string | null }[]>`
      select count(*)::int as n, count(amount)::int as known, sum(amount)::text as amount
      from crm.v_opportunities where company_id = ${ctx.companyId} and outcome = 'open' and status <> 'voided'`;
    const { n, known } = row!;
    if (known < n) return [];
    return [{
      id: "crm.pipeline",
      href: kpiGridHref("/crm/opportunities", [{ field: "outcome", op: "eq", value: "open" }]),
      label: "home.kpi.crm_pipeline.label",
      value: cents(Number(row!.amount ?? 0)),
      unit: "money",
      detail: { key: "home.kpi.crm_pipeline.detail", params: { count: n } },
    }];
  },
};

export const HOME_KPIS: HomeKpiProvider[] = [pipelineKpi];

/** Pipeline por etapa: the value of the open oportunidades in each etapa of the embudos, in the embudo's order. */
export const pipelineByStageChart: HomeChartProvider = {
  id: "crm.pipeline_by_stage",
  feature: "crm.opportunities",
  consult: "crm.opportunity.consult",
  compute: async (ctx): Promise<Chart[]> => {
    const rows = await ctx.tx<{ stage: string; n: number; known: number; amount: string | null }[]>`
      select s.name as stage, count(o.id)::int as n, count(o.amount)::int as known, sum(o.amount)::text as amount
      from crm.v_opportunities o join crm.v_stages s on s.id = o.stage_id
      where o.company_id = ${ctx.companyId} and o.outcome = 'open' and o.status <> 'voided'
      group by s.pipeline_id, s.line_no, s.name order by s.pipeline_id, s.line_no`;
    if (rows.length === 0 || rows.some((r) => r.known < r.n)) return [];
    return [{
      id: "crm.pipeline_by_stage",
      label: "home.chart.crm_pipeline_by_stage.label",
      kind: "bar",
      unit: "money",
      href: "/crm/opportunities",
      series: [{ label: "home.chart.series.pipeline", points: rows.map((r) => ({ label: r.stage, value: cents(Number(r.amount ?? 0)) })) }],
    }];
  },
};

export const HOME_CHARTS: HomeChartProvider[] = [pipelineByStageChart];
