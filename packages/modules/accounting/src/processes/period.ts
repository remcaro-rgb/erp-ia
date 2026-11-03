import { defineProcess, ProcessError } from "@erp/kernel";
import { z } from "zod";
import { runCloseChecks, type CloseCheck } from "./close-checks";
import { invalid, settingsOf } from "./common";
import { id } from "./schemas";

// Closing and reopening a period (accounting design §5.7, §4.14): closing is a gate. It records every check it ran, the sign-off,
// whether or not the period closes; a failed check keeps the period open and the run answers with the figures instead of throwing,
// so the rows commit and the attempt is kept.

const checkSchema = z.object({ check: z.string(), passed: z.boolean(), value: z.record(z.string(), z.unknown()), note: z.string() });

export const periodClose = defineProcess({
  id: "accounting.period.close",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.periods",
  sensitivity: "step-up",
  description: "Cierra un período contable tras correr los controles de cierre; si alguno falla el período sigue abierto y se devuelven las cifras",
  emits: ["accounting.period.closed"],
  input: z.object({ periodId: id }).strict(),
  output: z.object({ closed: z.boolean(), checks: z.array(checkSchema), failed: z.array(z.string()) }),
  handler: async (ctx, { periodId }) => {
    const [period] = await ctx.tx<{ id: string; number: number; status: string; starts_on: string; ends_on: string; fiscal_year_id: string }[]>`
      select id, number, status, starts_on::text, ends_on::text, fiscal_year_id from accounting.periods
      where id = ${periodId} and company_id = ${ctx.companyId} for update`;
    if (!period) throw new ProcessError("not_found", `period ${periodId} not found`);
    if (period.status !== "open") throw invalid(`period ${periodId} is ${period.status}`, "El período ya está cerrado");
    const [previous] = await ctx.tx<{ number: number; status: string; starts_on: string }[]>`
      select number, status, starts_on::text from accounting.periods
      where company_id = ${ctx.companyId} and ends_on < ${period.starts_on}::date order by ends_on desc limit 1`;
    if (previous && previous.status !== "closed") {
      throw invalid(`period ${previous.starts_on} is open`, `Cierra primero el período anterior (${previous.starts_on.slice(0, 7)}): los períodos se cierran en orden`);
    }

    const settings = await settingsOf(ctx);
    const checks: CloseCheck[] = await runCloseChecks(ctx, { id: period.id, startsOn: period.starts_on, endsOn: period.ends_on }, settings?.roundingTolerance ?? 0);
    await ctx.tx`
      insert into accounting.period_close_checks ${ctx.tx(
        checks.map((c) => ({
          company_id: ctx.companyId, period_id: periodId, check: c.check, value: ctx.tx.json(c.value as Parameters<typeof ctx.tx.json>[0]), passed: c.passed, note: c.note,
        })),
      )}`;
    const failed = checks.filter((c) => !c.passed);
    if (failed.length > 0) return { closed: false, checks, failed: failed.map((c) => c.note) };

    await ctx.tx`update accounting.periods set status = 'closed', closed_at = now(), closed_by = ${ctx.userId}, reopened_for = null where id = ${periodId}`;
    await ctx.emit("accounting.period.closed", { periodId, number: period.number, fiscalYearId: period.fiscal_year_id, startsOn: period.starts_on, endsOn: period.ends_on });
    return { closed: true, checks, failed: [] };
  },
});

export const periodReopen = defineProcess({
  id: "accounting.period.reopen",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.periods",
  sensitivity: "step-up",
  description: "Reabre un período cerrado de un año abierto, opcionalmente solo para un día: mientras tanto solo se contabilizan comprobantes de esa fecha",
  emits: ["accounting.period.reopened"],
  input: z.object({ periodId: id, date: z.iso.date().optional() }).strict(),
  output: z.object({ id: z.string(), reopenedFor: z.string().nullable() }),
  handler: async (ctx, { periodId, date }) => {
    const [period] = await ctx.tx<{ number: number; status: string; starts_on: string; ends_on: string; year_status: string; year: number }[]>`
      select p.number, p.status, p.starts_on::text, p.ends_on::text, y.status as year_status, y.year
      from accounting.periods p join accounting.fiscal_years y on y.id = p.fiscal_year_id
      where p.id = ${periodId} and p.company_id = ${ctx.companyId} for update of p`;
    if (!period) throw new ProcessError("not_found", `period ${periodId} not found`);
    if (period.status !== "closed") throw invalid(`period ${periodId} is open`, "El período ya está abierto");
    if (period.year_status !== "open") throw invalid(`fiscal year ${period.year} is closed`, `El año fiscal ${period.year} está cerrado: reábrelo antes con year.reopen`);
    if (date && (date < period.starts_on || date > period.ends_on)) throw invalid(`date ${date} outside the period`, "La fecha debe caer dentro del período");
    await ctx.tx`update accounting.periods set status = 'open', reopened_count = reopened_count + 1, reopened_for = ${date ?? null} where id = ${periodId}`;
    await ctx.emit("accounting.period.reopened", { periodId, number: period.number, startsOn: period.starts_on, endsOn: period.ends_on, reopenedFor: date ?? null });
    return { id: periodId, reopenedFor: date ?? null };
  },
});

export const PERIOD_PROCESSES = [periodClose, periodReopen];
