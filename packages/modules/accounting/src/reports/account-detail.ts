import { defineProcess, defineReport, ProcessError, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { cents, dimensionParams, reportInput, reportOutput, windowOf } from "./common";

// Auxiliar por cuenta (accounting design §6): the movements of an account and its descendants in a date range with the opening
// balance first and a running balance after each line, signed by the account's nature. An account the caller may not view
// answers "Sin acceso"; restricted descendants are omitted and counted.

const params = z.object({ accountId: z.uuid(), from: z.iso.date(), to: z.iso.date(), ...dimensionParams });

const columns: ReportColumn[] = [
  { field: "date", label: "report.col.date", type: "date" },
  { field: "number", label: "report.col.number", type: "text", mono: true, link: { entity: "accounting.entry", idField: "entry_id" } },
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true },
  { field: "party_name", label: "report.col.party", type: "text" },
  { field: "description", label: "report.col.description", type: "text" },
  { field: "debit", label: "report.col.debit", type: "money", total: "sum", mono: true },
  { field: "credit", label: "report.col.credit", type: "money", total: "sum", mono: true },
  { field: "balance", label: "report.col.balance", type: "money", mono: true },
];

export const accountDetailConsult = defineProcess({
  id: "accounting.report.account_detail",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Auxiliar por cuenta: saldo inicial, movimientos y saldo corrido de una cuenta y sus descendientes en un rango de fechas",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const [account] = await ctx.tx<{ code: string; name: string; nature: "debit" | "credit"; visible: boolean }[]>`
      select code, name, nature, accounting.can_view_account(id) as visible from accounting.accounts where id = ${p.accountId} and company_id = ${ctx.companyId}`;
    // A missing account answers like a restricted one: the refusal never tells whether an account id exists.
    if (!account || !account.visible) throw new ProcessError("forbidden", "the account is restricted for the caller", { details: ["Sin acceso"] });
    const sign = account.nature === "debit" ? 1 : -1;
    const like = `${account.code}%`;
    const filter = {
      cc: p.costCenterId ?? null, oa: p.openAuxiliaryId ?? null, item: p.itemId ?? null, bu: p.businessUnitId ?? null, party: p.partyId ?? null,
    };
    const [opening] = await ctx.tx<{ net: string | null }[]>`
      select sum(net) as net from accounting.v_ledger_lines
      where status = 'posted' and account_code like ${like} and date < ${p.from}::date
        and (${filter.cc}::uuid is null or cost_center_id = ${filter.cc}) and (${filter.oa}::uuid is null or open_auxiliary_id = ${filter.oa})
        and (${filter.item}::uuid is null or item_id = ${filter.item}) and (${filter.bu}::uuid is null or business_unit_id = ${filter.bu})
        and (${filter.party}::uuid is null or party_id = ${filter.party})`;
    const lines = await ctx.tx<{ entry_id: string; date: string; number: string; account_code: string; party_name: string | null; description: string | null; debit: string; credit: string }[]>`
      select entry_id, date::text as date, number, account_code, party_name, coalesce(description, entry_description) as description, debit, credit
      from accounting.v_ledger_lines
      where status = 'posted' and account_code like ${like} and date between ${p.from}::date and ${p.to}::date
        and (${filter.cc}::uuid is null or cost_center_id = ${filter.cc}) and (${filter.oa}::uuid is null or open_auxiliary_id = ${filter.oa})
        and (${filter.item}::uuid is null or item_id = ${filter.item}) and (${filter.bu}::uuid is null or business_unit_id = ${filter.bu})
        and (${filter.party}::uuid is null or party_id = ${filter.party})
      order by date, number, line_no`;
    const [raw] = await ctx.tx<{ n: number }[]>`
      select count(*)::int as n from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${ctx.companyId} and e.status = 'posted' and a.code like ${like} and e.date between ${p.from}::date and ${p.to}::date
        and (${filter.cc}::uuid is null or l.cost_center_id = ${filter.cc}) and (${filter.oa}::uuid is null or l.open_auxiliary_id = ${filter.oa})
        and (${filter.item}::uuid is null or l.item_id = ${filter.item}) and (${filter.bu}::uuid is null or l.business_unit_id = ${filter.bu})
        and (${filter.party}::uuid is null or l.party_id = ${filter.party})`;

    let balance = sign * Number(opening!.net ?? 0);
    const rows: Record<string, unknown>[] = [
      { row_kind: "opening", entry_id: null, date: p.from, number: "", account_code: account.code, party_name: "", description: "report.opening_balance", debit: 0, credit: 0, balance: cents(balance) },
    ];
    for (const line of lines) {
      balance += sign * (Number(line.debit) - Number(line.credit));
      rows.push({ row_kind: "line", entry_id: line.entry_id, date: line.date, number: line.number, account_code: line.account_code, party_name: line.party_name ?? "", description: line.description ?? "", debit: Number(line.debit), credit: Number(line.credit), balance: cents(balance) });
    }
    return windowOf(rows, state, {
      totals: ["debit", "credit"], isDetail: (r) => r.row_kind === "line",
      extra: { omitted: raw!.n - lines.length, openingBalance: cents(sign * Number(opening!.net ?? 0)), closingBalance: cents(balance), nature: account.nature },
    });
  },
});

export const accountDetailReport = defineReport({
  id: "accounting.account_detail",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.account_detail",
  params,
  consult: "accounting.report.account_detail",
  columns,
  totals: ["debit", "credit"],
  pdfTitle: "Auxiliar por cuenta",
});
