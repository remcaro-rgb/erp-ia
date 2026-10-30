import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { companyPack, invalid } from "./common";
import { reverseEntry, postEntry } from "./entry-post";
import { openFiscalYear } from "./fiscal-year";
import { resolveRoleAccount } from "./mapping";
import { id } from "./schemas";

// Year close and reopen (accounting design §5.7): the result accounts are zeroed against the summary account in the Cierre Fuente,
// and the summary moves to the profit or loss account by sign. Balances are computed, so nothing else is written.

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

interface Group {
  account_id: string;
  party_id: string | null;
  cost_center_id: string | null;
  open_auxiliary_id: string | null;
  item_id: string | null;
  business_unit_id: string | null;
  net: string;
}

async function insertClosingEntry(
  ctx: ProcessContext,
  journalId: string,
  date: string,
  description: string,
  lines: { accountId: string; debit: number; credit: number; group?: Group }[],
): Promise<string> {
  const [entry] = await ctx.tx<{ id: string }[]>`
    insert into accounting.entries ${ctx.tx({
      company_id: ctx.companyId, journal_id: journalId, date, description, origin: "auto", status: "draft", is_closing: true, chain_id: ctx.chainId,
    })}
    returning id`;
  await ctx.tx`insert into accounting.entry_lines ${ctx.tx(
    lines.map((line, index) => ({
      company_id: ctx.companyId, entry_id: entry!.id, line_no: index + 1, account_id: line.accountId, party_id: line.group?.party_id ?? null,
      cost_center_id: line.group?.cost_center_id ?? null, open_auxiliary_id: line.group?.open_auxiliary_id ?? null, item_id: line.group?.item_id ?? null,
      business_unit_id: line.group?.business_unit_id ?? null, debit: line.debit, credit: line.credit, debit_doc: line.debit, credit_doc: line.credit,
    })),
  )}`;
  await postEntry(ctx, entry!.id, { origin: "human", skipFourEyes: true, engine: true });
  return entry!.id;
}

export const yearClose = defineProcess({
  id: "accounting.year.close",
  module: "accounting",
  kind: "update",
  feature: "accounting.periods",
  sensitivity: "step-up",
  description: "Cierra el año fiscal: salda las cuentas de resultado contra ganancias y pérdidas y lleva el resultado a utilidad o pérdida del ejercicio",
  emits: ["accounting.year.closed"],
  input: z.object({ fiscalYearId: id }).strict(),
  output: z.object({ id: z.string(), result: z.number(), closingEntryIds: z.array(z.string()), nextYearId: z.string().nullable() }),
  handler: async (ctx, { fiscalYearId }) => {
    const [year] = await ctx.tx<{ year: number; status: string; starts_on: string; ends_on: string }[]>`
      select year, status, starts_on::text, ends_on::text from accounting.fiscal_years where id = ${fiscalYearId} and company_id = ${ctx.companyId} for update`;
    if (!year) throw new ProcessError("not_found", `fiscal year ${fiscalYearId} not found`);
    if (year.status !== "open") throw invalid(`fiscal year ${year.year} is closed`, `El año fiscal ${year.year} ya está cerrado`);
    const [open] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from accounting.periods where fiscal_year_id = ${fiscalYearId} and status <> 'closed'`;
    if (open!.n > 0) throw invalid(`${open!.n} periods are open`, `Para cerrar el año se deben cerrar antes sus doce períodos (faltan ${open!.n})`);

    const summary = await resolveRoleAccount(ctx, "income_summary");
    const profit = await resolveRoleAccount(ctx, "current_year_profit");
    const loss = await resolveRoleAccount(ctx, "current_year_loss");
    if (!summary || !profit || !loss) {
      throw invalid("closing roles are not mapped", "Faltan por mapear las cuentas de los roles ganancias y pérdidas, utilidad del ejercicio y pérdida del ejercicio");
    }
    const [journal] = await ctx.tx<{ id: string }[]>`select id from accounting.journals where company_id = ${ctx.companyId} and kind = 'closing' and is_active order by code limit 1`;
    if (!journal) throw invalid("no closing journal", "No hay una fuente de cierre activa");

    // Result accounts: those with a statement section that is not a balance-sheet one, other than the summary account itself.
    const pack = await companyPack(ctx);
    const balanceSheet = pack.statementLayouts().balanceSheet.map((s) => s.code);
    const groups = await ctx.tx<Group[]>`
      select l.account_id, l.party_id, l.cost_center_id, l.open_auxiliary_id, l.item_id, l.business_unit_id, sum(l.debit - l.credit) as net
      from accounting.entry_lines l
      join accounting.entries e on e.id = l.entry_id
      join accounting.accounts a on a.id = l.account_id
      join accounting.periods p on p.id = e.period_id
      where l.company_id = ${ctx.companyId} and p.fiscal_year_id = ${fiscalYearId} and e.status in ('posted', 'reversed')
        and not e.is_opening and not e.is_closing
        and a.statement_section is not null and a.statement_section <> all(${balanceSheet}::text[]) and a.id <> ${summary.accountId}
      group by l.account_id, l.party_id, l.cost_center_id, l.open_auxiliary_id, l.item_id, l.business_unit_id
      having sum(l.debit - l.credit) <> 0`;

    const closingEntryIds: string[] = [];
    let result = 0;
    if (groups.length > 0) {
      const lines = groups.map((g) => {
        const net = round4(Number(g.net));
        return { accountId: g.account_id, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0, group: g };
      });
      const debit = lines.reduce((sum, l) => sum + l.debit, 0);
      const credit = lines.reduce((sum, l) => sum + l.credit, 0);
      result = round4(debit - credit); // positive: credits (income) outweighed debits (expense): a profit
      if (result !== 0) lines.push({ accountId: summary.accountId, debit: result < 0 ? -result : 0, credit: result > 0 ? result : 0 } as (typeof lines)[number]);
      closingEntryIds.push(await insertClosingEntry(ctx, journal.id, year.ends_on, `Cierre del año ${year.year}: saldo de las cuentas de resultado`, lines));
      if (result !== 0) {
        closingEntryIds.push(
          await insertClosingEntry(ctx, journal.id, year.ends_on, `Cierre del año ${year.year}: ${result > 0 ? "utilidad" : "pérdida"} del ejercicio`, [
            { accountId: summary.accountId, debit: result > 0 ? result : 0, credit: result < 0 ? -result : 0 },
            { accountId: result > 0 ? profit.accountId : loss.accountId, debit: result < 0 ? -result : 0, credit: result > 0 ? result : 0 },
          ]),
        );
      }
    }

    await ctx.tx`update accounting.fiscal_years set status = 'closed' where id = ${fiscalYearId}`;
    const [next] = await ctx.tx<{ id: string }[]>`select id from accounting.fiscal_years where company_id = ${ctx.companyId} and year = ${year.year + 1}`;
    const nextYearId = next?.id ?? (await openFiscalYear(ctx, pack, year.year + 1));
    await ctx.emit("accounting.year.closed", { fiscalYearId, year: year.year, result, closingEntryIds });
    return { id: fiscalYearId, result, closingEntryIds, nextYearId };
  },
});

export const yearReopen = defineProcess({
  id: "accounting.year.reopen",
  module: "accounting",
  kind: "update",
  feature: "accounting.periods",
  sensitivity: "step-up",
  description: "Reabre un año fiscal cerrado: revierte sus comprobantes de cierre y reabre el año y su último período",
  emits: ["accounting.entry.reversed"],
  input: z.object({ fiscalYearId: id, reason: z.string().trim().min(1).max(500).default("Reapertura del año fiscal") }).strict(),
  output: z.object({ id: z.string(), reversedEntryIds: z.array(z.string()) }),
  handler: async (ctx, { fiscalYearId, reason }) => {
    const [year] = await ctx.tx<{ year: number; status: string; ends_on: string }[]>`
      select year, status, ends_on::text from accounting.fiscal_years where id = ${fiscalYearId} and company_id = ${ctx.companyId} for update`;
    if (!year) throw new ProcessError("not_found", `fiscal year ${fiscalYearId} not found`);
    if (year.status !== "closed") throw invalid(`fiscal year ${year.year} is open`, `El año fiscal ${year.year} ya está abierto`);
    const [later] = await ctx.tx<{ year: number }[]>`
      select y.year from accounting.fiscal_years y
      where y.company_id = ${ctx.companyId} and y.year > ${year.year} and y.status = 'closed' limit 1`;
    if (later) throw invalid(`fiscal year ${later.year} is closed`, `Reabre primero el año fiscal ${later.year}: los años se reabren del más reciente al más antiguo`);

    // December opens first: the reversals are dated on the last day of the year.
    await ctx.tx`
      update accounting.periods set status = 'open', reopened_count = reopened_count + 1, reopened_for = null
       where fiscal_year_id = ${fiscalYearId} and number = (select max(number) from accounting.periods where fiscal_year_id = ${fiscalYearId})`;
    const closing = await ctx.tx<{ id: string }[]>`
      select e.id from accounting.entries e join accounting.periods p on p.id = e.period_id
      where e.company_id = ${ctx.companyId} and p.fiscal_year_id = ${fiscalYearId} and e.is_closing and e.status = 'posted' and e.reversal_of_id is null
      order by e.seq desc`;
    const reversed: string[] = [];
    for (const entry of closing) {
      const out = await reverseEntry(ctx, entry.id, { date: year.ends_on, reason }, { allowClosing: true });
      reversed.push(out.id);
    }
    await ctx.tx`update accounting.fiscal_years set status = 'open' where id = ${fiscalYearId}`;
    return { id: fiscalYearId, reversedEntryIds: reversed };
  },
});

export const YEAR_PROCESSES = [yearClose, yearReopen];
