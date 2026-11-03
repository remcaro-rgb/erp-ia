import { defineProcess, defineReport, ProcessError, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { cents, reportInput, reportOutput, windowOf } from "./common";

// Auxiliar por tercero (accounting design §6): the movements of one party in a date range, optionally on some accounts, with the
// opening balance first and a running balance (debit minus credit). Restricted accounts are omitted and counted (§5.13).

const params = z.object({ partyId: z.uuid(), accountIds: z.array(z.uuid()).max(100).optional(), from: z.iso.date(), to: z.iso.date() });

const columns: ReportColumn[] = [
  { field: "date", label: "report.col.date", type: "date" },
  { field: "number", label: "report.col.number", type: "text", mono: true, link: { entity: "accounting.entry", idField: "entry_id" } },
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true },
  { field: "account_name", label: "report.col.account_name", type: "text" },
  { field: "description", label: "report.col.description", type: "text" },
  { field: "debit", label: "report.col.debit", type: "money", total: "sum", mono: true },
  { field: "credit", label: "report.col.credit", type: "money", total: "sum", mono: true },
  { field: "balance", label: "report.col.balance", type: "money", mono: true },
];

export const partyDetailConsult = defineProcess({
  id: "accounting.report.party_detail",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Auxiliar por tercero: saldo inicial, movimientos y saldo corrido de un tercero en un rango de fechas, opcionalmente en algunas cuentas",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const [party] = await ctx.tx<{ legal_name: string | null }[]>`select legal_name from core.v_parties where id = ${p.partyId} and company_id = ${ctx.companyId}`;
    if (!party) throw new ProcessError("invalid_input", `party ${p.partyId} not found`, { details: ["El tercero indicado no existe o no es visible"] });
    const accounts = p.accountIds ?? null;
    const [opening] = await ctx.tx<{ net: string | null }[]>`
      select sum(net) as net from accounting.v_ledger_lines
      where status = 'posted' and party_id = ${p.partyId} and date < ${p.from}::date and (${accounts}::uuid[] is null or account_id = any(${accounts}::uuid[]))`;
    const lines = await ctx.tx<{ entry_id: string; date: string; number: string; account_code: string; account_name: string; description: string | null; debit: string; credit: string }[]>`
      select entry_id, date::text as date, number, account_code, account_name, coalesce(description, entry_description) as description, debit, credit
      from accounting.v_ledger_lines
      where status = 'posted' and party_id = ${p.partyId} and date between ${p.from}::date and ${p.to}::date
        and (${accounts}::uuid[] is null or account_id = any(${accounts}::uuid[]))
      order by date, number, line_no`;
    const [raw] = await ctx.tx<{ n: number }[]>`
      select count(*)::int as n from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
      where l.company_id = ${ctx.companyId} and e.status = 'posted' and l.party_id = ${p.partyId} and e.date between ${p.from}::date and ${p.to}::date
        and (${accounts}::uuid[] is null or l.account_id = any(${accounts}::uuid[]))`;
    let balance = Number(opening!.net ?? 0);
    const rows: Record<string, unknown>[] = [
      { row_kind: "opening", entry_id: null, date: p.from, number: "", account_code: "", account_name: "", description: "report.opening_balance", debit: 0, credit: 0, balance: cents(balance) },
    ];
    for (const line of lines) {
      balance += Number(line.debit) - Number(line.credit);
      rows.push({ row_kind: "line", entry_id: line.entry_id, date: line.date, number: line.number, account_code: line.account_code, account_name: line.account_name, description: line.description ?? "", debit: Number(line.debit), credit: Number(line.credit), balance: cents(balance) });
    }
    return windowOf(rows, state, {
      totals: ["debit", "credit"], isDetail: (r) => r.row_kind === "line",
      extra: { omitted: raw!.n - lines.length, openingBalance: cents(Number(opening!.net ?? 0)), closingBalance: cents(balance), party: party.legal_name },
    });
  },
});

export const partyDetailReport = defineReport({
  id: "accounting.party_detail",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.party_detail",
  params,
  consult: "accounting.report.party_detail",
  columns,
  totals: ["debit", "credit"],
  pdfTitle: "Auxiliar por tercero",
});
