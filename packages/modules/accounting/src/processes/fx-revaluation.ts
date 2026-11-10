import { defineProcess, moneyText, ProcessError, rateText, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { invalid } from "./common";
import { insertMirror, postEntry, reverseEntry } from "./entry-post";
import { resolveRoleAccount } from "./mapping";
import { id } from "./schemas";

// Ajuste por diferencia en cambio (plan 2B.2 Task 34.7; FX §5 unrealized; owner items 126 (b), (c), (d) as recommended pending the
// accountant, and 130, decided 2026-11-09; NIC 21 / NIIF para Pymes sección 30: monetary items at the closing rate; art. 288 ET: no fiscal
// effect until realized).
//   * accounting.fx_revaluation.run {periodId} (step-up): every open receivable item of an invoice in a currency other than the company's
//     (accounting.open_items at the period's last day, kind document) is carried at its invoice's rate; at the closing rate (the rate table's
//     rate of the period's last day, item 126 (b): any period, month end or year end) it is worth open_doc × rate. One entry «Ajuste por
//     diferencia en cambio» in the Notas fuente (kind general) dated the period's last day: one receivable line per invoice for the
//     difference (pesos only, no document amount), and the gain to fx_gain or the loss to fx_loss (dimension fx_kind:unrealized). Its
//     reversal is dated the first day of the next period (item 126 (c)), so a later collection settles at the invoice's own rate and posts
//     the whole realized difference (Task 34.5). Customer advances are non-monetary and are not revalued (item 126 (d)); foreign bank and
//     cash balances are not either (item 130: ledger accounts carry no currency until the bank module). Only invoice documents are read: a
//     foreign debit note's own document is left at its rate (none exist in 2B.2: notes credit or annul).
//     A rerun of a period voids its posted run first, in the same transaction, and posts again. Refused: period_closed (the period or the
//     next one is closed, or there is no next one), exchange_rate_missing (a foreign currency with open items and no closing rate).
//   * accounting.fx_revaluation.void {revaluationId} (step-up): two mirror entries, one at each date, so both entries are undone in their
//     own periods; the run is Anulado.
// The run's documento (accounting.fx_revaluations) records the closing rates and, per invoice, the receivable line it wrote: that is how
// accounting.open_items attaches the adjustment, its reversal and a void's mirrors to the invoice (0153).

const round2 = (value: number) => Math.round(value * 100) / 100 || 0;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** Rates within three days before the date answer for it (a weekend or a holiday month end), as core.exchange_rate.for_date. */
const RATE_LOOKBACK_DAYS = 3;
const DESCRIPTION = "Ajuste por diferencia en cambio";

interface Period {
  id: string;
  status: string;
  starts_on: string;
  ends_on: string;
}

async function periodOf(ctx: ProcessContext, periodId: string): Promise<Period> {
  const [period] = await ctx.tx<Period[]>`
    select id, status, starts_on::text, ends_on::text from accounting.periods where id = ${periodId} and company_id = ${ctx.companyId} for update`;
  if (!period) throw new ProcessError("not_found", `period ${periodId} not found`);
  return period;
}

/** Both periods an adjustment touches must be open: its own (the entry) and the next (the reversal). */
async function assertOpen(ctx: ProcessContext, period: Period): Promise<string> {
  if (period.status !== "open") throw invalid(`period_closed: period ${period.starts_on} is closed`, `El período ${period.starts_on.slice(0, 7)} está cerrado: reábrelo para calcular la diferencia en cambio`);
  const nextDay = addDays(period.ends_on, 1);
  const [next] = await ctx.tx<{ status: string }[]>`
    select status from accounting.periods where company_id = ${ctx.companyId} and ${nextDay}::date between starts_on and ends_on`;
  if (!next) throw invalid(`period_closed: no period holds ${nextDay}`, `No hay un período contable para el ${nextDay}, donde va la reversión del ajuste: abre el año siguiente`);
  if (next.status !== "open") throw invalid(`period_closed: the period of ${nextDay} is closed`, `El período de ${nextDay.slice(0, 7)}, donde va la reversión del ajuste, está cerrado`);
  return nextDay;
}

interface Revaluation {
  id: string;
  status: string;
  date: string;
  entry_id: string | null;
  reversal_entry_id: string | null;
}

/** A mirror of a posted entry (debits and credits swapped) at `date`, posted; the run's void and rerun undo both entries this way. */
async function mirror(ctx: ProcessContext, entryId: string, date: string, reason: string): Promise<string> {
  const [original] = await ctx.tx<{ journal_id: string; number: string; currency: string; exchange_rate: string; source_entity: string; source_record_id: string }[]>`
    select journal_id, number, currency, exchange_rate, source_entity, source_record_id from accounting.entries where id = ${entryId} for update`;
  const [entry] = await ctx.tx<{ id: string }[]>`
    insert into accounting.entries ${ctx.tx({
      company_id: ctx.companyId, journal_id: original!.journal_id, date, description: `Anulación de ${original!.number}: ${reason}`, origin: "auto", status: "draft",
      requires_approval: false, posts: true, reversal_of_id: entryId, currency: original!.currency, exchange_rate: original!.exchange_rate,
      source_entity: original!.source_entity, source_record_id: original!.source_record_id, chain_id: ctx.chainId,
    })}
    returning id`;
  await insertMirror(ctx, entryId, entry!.id);
  await postEntry(ctx, entry!.id, { engine: true });
  return entry!.id;
}

/** Voids a posted run: mirrors its entry and its reversal at their own dates and marks it Anulado. */
async function voidRun(ctx: ProcessContext, run: Revaluation, reason: string): Promise<void> {
  let voidEntryId: string | null = null;
  let voidReversalId: string | null = null;
  if (run.entry_id) voidEntryId = await mirror(ctx, run.entry_id, run.date, reason);
  if (run.reversal_entry_id) {
    const [reversal] = await ctx.tx<{ date: string }[]>`select date::text from accounting.entries where id = ${run.reversal_entry_id}`;
    voidReversalId = await mirror(ctx, run.reversal_entry_id, reversal!.date, reason);
  }
  await ctx.tx`
    update accounting.fx_revaluations set status = 'voided', void_reason = ${reason}, voided_at = now(), void_entry_id = ${voidEntryId}, void_reversal_entry_id = ${voidReversalId}
    where id = ${run.id}`;
}

interface OpenItem {
  account_id: string;
  party_id: string;
  entry_id: string;
  invoice_id: string;
  currency: string;
  open: string;
  open_doc: string;
}

const runOutput = z.object({ revaluationId: z.string(), entryId: z.string().nullable(), reversalEntryId: z.string().nullable(), lines: z.number() });

export const fxRevaluationRun = defineProcess({
  id: "accounting.fx_revaluation.run",
  module: "accounting",
  kind: "create",
  recordAccess: "none",
  feature: "accounting.periods",
  sensitivity: "step-up",
  description: "Calcula la diferencia en cambio no realizada de las facturas abiertas en moneda extranjera al cierre de un período y la revierte el primer día del siguiente",
  emits: ["accounting.fx_revaluation.posted", "accounting.entry.posted", "accounting.entry.reversed"],
  input: z.object({ periodId: id }).strict(),
  output: runOutput,
  handler: async (ctx, { periodId }) => {
    const period = await periodOf(ctx, periodId);
    const nextDay = await assertOpen(ctx, period);
    const [company] = await ctx.tx<{ currency: string }[]>`select currency_code::text as currency from kernel.companies where id = ${ctx.companyId}`;

    // A rerun: the previous run of the period is voided first.
    const [previous] = await ctx.tx<Revaluation[]>`
      select id, status, date::text, entry_id, reversal_entry_id from accounting.fx_revaluations
      where company_id = ${ctx.companyId} and period_id = ${periodId} and status = 'posted' for update`;
    if (previous) await voidRun(ctx, previous, "recalculada");

    const items = await ctx.tx<OpenItem[]>`
      select o.account_id, o.party_id, o.entry_id, e.source_record_id as invoice_id, o.currency, o.open::text, o.open_doc::text
      from accounting.open_items(${ctx.companyId}, ${period.ends_on}::date) o
      join accounting.entries e on e.id = o.entry_id and e.source_entity = 'invoicing.invoice'
      where o.kind = 'document' and o.currency <> ${company!.currency} and o.open_doc > 0
      order by o.currency, o.date, e.seq, o.line_no`;

    const currencies = [...new Set(items.map((i) => i.currency))];
    const closingRates: Record<string, number> = {};
    for (const currency of currencies) {
      const [rate] = await ctx.tx<{ rate: string }[]>`
        select rate::text from core.v_exchange_rates
        where company_id = ${ctx.companyId} and currency = ${currency} and rate_date <= ${period.ends_on}::date
          and rate_date >= ${period.ends_on}::date - ${RATE_LOOKBACK_DAYS}::int
        order by rate_date desc limit 1`;
      if (!rate) {
        throw new ProcessError("invalid_input", `exchange_rate_missing: no ${currency} rate on ${period.ends_on}`, {
          details: [`No hay tasa de cambio para ${currency} el ${period.ends_on}; regístrala en Tasas de cambio`],
        });
      }
      closingRates[currency] = Number(rate.rate);
    }

    const adjustments = items
      .map((item) => {
        const rate = closingRates[item.currency]!;
        const carrying = Number(item.open);
        const revalued = round2(Number(item.open_doc) * rate);
        return { ...item, rate, carrying, revalued, adjustment: round2(revalued - carrying) };
      })
      .filter((a) => a.adjustment !== 0);

    const [revaluation] = await ctx.tx<{ id: string }[]>`
      insert into accounting.fx_revaluations ${ctx.tx({
        company_id: ctx.companyId, period_id: periodId, date: period.ends_on, closing_rates: ctx.tx.json(closingRates), lines_count: adjustments.length,
        status: "posted", requires_approval: false, posts: true,
      })}
      returning id`;
    const revaluationId = revaluation!.id;

    let entryId: string | null = null;
    let reversalEntryId: string | null = null;
    if (adjustments.length > 0) {
      const [journal] = await ctx.tx<{ id: string }[]>`select id from accounting.journals where company_id = ${ctx.companyId} and kind = 'general' and is_active order by code limit 1`;
      if (!journal) throw invalid("no_journal: no active general journal", "No hay una fuente de notas de contabilidad activa para el ajuste por diferencia en cambio");
      const gainTotal = round2(adjustments.filter((a) => a.adjustment > 0).reduce((s, a) => s + a.adjustment, 0));
      const lossTotal = round2(adjustments.filter((a) => a.adjustment < 0).reduce((s, a) => s - a.adjustment, 0));
      const gain = gainTotal > 0 ? await resolveRoleAccount(ctx, "fx_gain", "fx_kind:unrealized") : null;
      const loss = lossTotal > 0 ? await resolveRoleAccount(ctx, "fx_loss", "fx_kind:unrealized") : null;
      if ((gainTotal > 0 && !gain) || (lossTotal > 0 && !loss)) {
        throw new ProcessError("invalid_input", "missing_account_mapping: fx_gain or fx_loss is not mapped", { details: ["Falta mapear las cuentas de diferencia en cambio (fx_gain, fx_loss) en Mapeo de cuentas"] });
      }
      const numbers = await invoiceNumbers(ctx, adjustments.map((a) => a.invoice_id));
      const rows = adjustments.map((a, index) => ({
        company_id: ctx.companyId, line_no: index + 1, account_id: a.account_id, party_id: a.party_id,
        description: `${DESCRIPTION} ${numbers.get(a.invoice_id) ?? ""} (${moneyText(Number(a.open_doc), a.currency)} a ${rateText(a.rate)})`.replace(/\s+/g, " "),
        debit: a.adjustment > 0 ? a.adjustment : 0, credit: a.adjustment < 0 ? -a.adjustment : 0, debit_doc: 0, credit_doc: 0,
      }));
      if (gainTotal > 0) rows.push({ company_id: ctx.companyId, line_no: rows.length + 1, account_id: gain!.accountId, party_id: null as never, description: `${DESCRIPTION}: ganancia no realizada`, debit: 0, credit: gainTotal, debit_doc: 0, credit_doc: 0 });
      if (lossTotal > 0) rows.push({ company_id: ctx.companyId, line_no: rows.length + 1, account_id: loss!.accountId, party_id: null as never, description: `${DESCRIPTION}: pérdida no realizada`, debit: lossTotal, credit: 0, debit_doc: 0, credit_doc: 0 });

      const [entry] = await ctx.tx<{ id: string }[]>`
        insert into accounting.entries ${ctx.tx({
          company_id: ctx.companyId, journal_id: journal.id, date: period.ends_on, description: `${DESCRIPTION} al ${period.ends_on}`, origin: "auto", status: "draft",
          requires_approval: false, posts: true, currency: company!.currency, exchange_rate: 1, source_entity: "accounting.fx_revaluation", source_record_id: revaluationId,
          chain_id: ctx.chainId,
        })}
        returning id`;
      entryId = entry!.id;
      await ctx.tx`insert into accounting.entry_lines ${ctx.tx(rows.map((r) => ({ ...r, entry_id: entryId })))}`;
      await postEntry(ctx, entryId, { engine: true });
      reversalEntryId = (await reverseEntry(ctx, entryId, { date: nextDay, reason: "diferencia en cambio no realizada del período anterior" }, { engine: true })).id;

      const written = await ctx.tx<{ id: string; line_no: number }[]>`select id, line_no from accounting.entry_lines where entry_id = ${entryId} and line_no <= ${adjustments.length} order by line_no`;
      await ctx.tx`
        insert into accounting.fx_revaluation_lines ${ctx.tx(adjustments.map((a, index) => ({
          company_id: ctx.companyId, revaluation_id: revaluationId, line_no: index + 1, entry_line_id: written[index]!.id, invoice_id: a.invoice_id,
          invoice_number: numbers.get(a.invoice_id) ?? null, party_id: a.party_id, currency: a.currency, open_doc: Number(a.open_doc), carrying: a.carrying,
          closing_rate: a.rate, revalued: a.revalued, adjustment: a.adjustment,
        })))}`;
    }
    await ctx.tx`update accounting.fx_revaluations set entry_id = ${entryId}, reversal_entry_id = ${reversalEntryId} where id = ${revaluationId}`;
    await ctx.emit("accounting.fx_revaluation.posted", {
      revaluationId, periodId, date: period.ends_on, reversalDate: nextDay, closingRates, entryId, reversalEntryId, lines: adjustments.length,
      gain: round2(adjustments.filter((a) => a.adjustment > 0).reduce((s, a) => s + a.adjustment, 0)),
      loss: round2(adjustments.filter((a) => a.adjustment < 0).reduce((s, a) => s - a.adjustment, 0)),
    });
    return { revaluationId, entryId, reversalEntryId, lines: adjustments.length };
  },
});

/** The invoices' numbers, from invoicing's published view (rule 3) when the module is installed; none otherwise. */
async function invoiceNumbers(ctx: ProcessContext, invoiceIds: string[]): Promise<Map<string, string>> {
  const [view] = await ctx.tx<{ present: boolean }[]>`select to_regclass('invoicing.v_receivable_invoices') is not null as present`;
  if (!view!.present || invoiceIds.length === 0) return new Map();
  const rows = await ctx.tx<{ id: string; number: string | null }[]>`select id, number from invoicing.v_receivable_invoices where id = any(${invoiceIds}::uuid[])`;
  return new Map(rows.filter((r) => r.number).map((r) => [r.id, r.number!]));
}

export const fxRevaluationVoid = defineProcess({
  id: "accounting.fx_revaluation.void",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.periods",
  sensitivity: "step-up",
  description: "Anula un ajuste por diferencia en cambio: revierte su comprobante y su reversión, cada uno en su fecha",
  emits: ["accounting.entry.posted"],
  input: z.object({ revaluationId: id, reason: z.string().trim().min(1).max(500).optional() }).strict(),
  output: z.object({ id: z.string(), status: z.literal("voided") }),
  handler: async (ctx, { revaluationId, reason }) => {
    const [run] = await ctx.tx<(Revaluation & { period_id: string })[]>`
      select id, status, date::text, entry_id, reversal_entry_id, period_id from accounting.fx_revaluations
      where id = ${revaluationId} and company_id = ${ctx.companyId} for update`;
    if (!run) throw new ProcessError("not_found", `fx revaluation ${revaluationId} not found`);
    if (run.status !== "posted") throw invalid(`fx revaluation ${revaluationId} is ${run.status}`, "El ajuste por diferencia en cambio ya está anulado");
    await assertOpen(ctx, await periodOf(ctx, run.period_id));
    await voidRun(ctx, run, reason ?? "anulado");
    return { id: revaluationId, status: "voided" as const };
  },
});

export const FX_REVALUATION_PROCESSES = [fxRevaluationRun, fxRevaluationVoid];
