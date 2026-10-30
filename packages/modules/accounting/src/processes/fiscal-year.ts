import { defineProcess, ProcessError, type AccountingPack, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { companyPack, invalid } from "./common";
import { id, rowOutput } from "./schemas";

// Fiscal years and their twelve monthly periods (accounting design §4.4, §5.7).

const pad = (n: number) => String(n).padStart(2, "0");

/** The twelve calendar months of the year that starts on `startsOn` (YYYY-MM-DD). */
export function monthlyPeriods(startsOn: string): { number: number; startsOn: string; endsOn: string }[] {
  const [y, m] = startsOn.split("-").map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const first = new Date(Date.UTC(y, m - 1 + i, 1));
    const last = new Date(Date.UTC(y, m + i, 0));
    const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return { number: i + 1, startsOn: iso(first), endsOn: iso(last) };
  });
}

/**
 * Creates fiscal year `year` with its twelve periods. Refused when it exists or leaves a gap: the first year of a company
 * opens freely, any other must be next to a year that exists. Returns the new year's id.
 */
export async function openFiscalYear(ctx: ProcessContext, pack: AccountingPack, year: number): Promise<string> {
  const years = await ctx.tx<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${ctx.companyId}`;
  const have = new Set(years.map((y) => y.year));
  if (have.has(year)) throw invalid(`fiscal year ${year} exists`, `El año fiscal ${year} ya existe`);
  if (have.size > 0 && !have.has(year - 1) && !have.has(year + 1)) {
    throw invalid(`fiscal year ${year} leaves a gap`, `No se puede abrir ${year}: falta el año fiscal contiguo`);
  }
  const calendar = pack.fiscalYearFor(`${year}-01-01`);
  const [fiscalYear] = await ctx.tx<{ id: string }[]>`
    insert into accounting.fiscal_years (company_id, year, starts_on, ends_on)
    values (${ctx.companyId}, ${calendar.year}, ${calendar.startsOn}, ${calendar.endsOn}) returning id`;
  const periods = monthlyPeriods(calendar.startsOn).map((p) => ({
    company_id: ctx.companyId, fiscal_year_id: fiscalYear!.id, number: p.number, starts_on: p.startsOn, ends_on: p.endsOn,
  }));
  await ctx.tx`insert into accounting.periods ${ctx.tx(periods)}`;
  return fiscalYear!.id;
}

export const fiscalYearOpen = defineProcess({
  id: "accounting.fiscal_year.open",
  module: "accounting",
  kind: "create",
  feature: "accounting.periods",
  description: "Abre un año fiscal con sus doce períodos mensuales",
  input: z.object({ year: z.number().int().min(2000).max(2100) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { year }) => ({ id: await openFiscalYear(ctx, await companyPack(ctx), year) }),
});

export const fiscalYearConsult = defineProcess({
  id: "accounting.fiscal_year.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.periods",
  description: "Consulta un año fiscal",
  input: z.object({ id }),
  output: rowOutput,
  handler: async (ctx, { id: yearId }) => {
    const [row] = await ctx.tx`select * from accounting.v_fiscal_years where id = ${yearId}`;
    if (!row) throw new ProcessError("not_found", `fiscal year ${yearId} not found`);
    return { ...row, id: yearId };
  },
});

export const periodConsult = defineProcess({
  id: "accounting.period.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.periods",
  description: "Consulta un período contable",
  input: z.object({ id }),
  output: rowOutput,
  handler: async (ctx, { id: periodId }) => {
    const [row] = await ctx.tx`select * from accounting.v_periods where id = ${periodId}`;
    if (!row) throw new ProcessError("not_found", `period ${periodId} not found`);
    return { ...row, id: periodId };
  },
});

export const FISCAL_YEAR_PROCESSES = [fiscalYearOpen, fiscalYearConsult, periodConsult];
