import { defineProcess, defineReport, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { reportInput, reportOutput, windowOf } from "./common";

// Libro diario (accounting design §6): every posted line of a date range in date, number and line order. Lines of accounts the
// caller may not view are left out and counted (`omitted`), so the page can say how many were hidden (§5.13).

const params = z.object({ from: z.iso.date(), to: z.iso.date(), journalId: z.uuid().optional() });

const columns: ReportColumn[] = [
  { field: "date", label: "report.col.date", type: "date" },
  { field: "number", label: "report.col.number", type: "text", mono: true, link: { entity: "accounting.entry", idField: "entry_id" } },
  { field: "journal_code", label: "report.col.journal", type: "text", mono: true },
  { field: "line_no", label: "report.col.line_no", type: "number", mono: true },
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true },
  { field: "account_name", label: "report.col.account_name", type: "text" },
  { field: "party_name", label: "report.col.party", type: "text" },
  { field: "description", label: "report.col.description", type: "text" },
  { field: "debit", label: "report.col.debit", type: "money", total: "sum", mono: true },
  { field: "credit", label: "report.col.credit", type: "money", total: "sum", mono: true },
];

export const journalBookConsult = defineProcess({
  id: "accounting.report.journal_book",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Libro diario: todas las líneas contabilizadas de un rango de fechas, opcionalmente de una fuente; las cuentas restringidas se omiten y se cuentan",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const rows = await ctx.tx<Record<string, unknown>[]>`
      select entry_id, date::text as date, number, journal_code, line_no, account_code, account_name, party_name, coalesce(description, entry_description) as description,
             debit::float8 as debit, credit::float8 as credit
      from accounting.v_ledger_lines
      where status = 'posted' and date between ${p.from}::date and ${p.to}::date and (${p.journalId ?? null}::uuid is null or journal_id = ${p.journalId ?? null})
      order by date, number, line_no`;
    const [raw] = await ctx.tx<{ n: number }[]>`
      select count(*)::int as n from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
      where l.company_id = ${ctx.companyId} and e.status = 'posted' and e.date between ${p.from}::date and ${p.to}::date
        and (${p.journalId ?? null}::uuid is null or e.journal_id = ${p.journalId ?? null})`;
    return windowOf(rows, state, { totals: ["debit", "credit"], extra: { omitted: raw!.n - rows.length } });
  },
});

export const journalBookReport = defineReport({
  id: "accounting.journal_book",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.journal_book",
  params,
  consult: "accounting.report.journal_book",
  columns,
  totals: ["debit", "credit"],
  pdfTitle: "Libro diario",
});
