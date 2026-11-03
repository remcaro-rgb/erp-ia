import { defineProcess, defineReport, ProcessError, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { DIMENSION_DEFS, DIMENSIONS } from "../dimensions";
import { cents, reportInput, reportOutput, windowOf } from "./common";

// Auxiliar por dimensión analítica (accounting design §6): debit, credit and net by account for one node of a dimension tree and all
// its descendants in a date range, optionally on one account and its descendants. Restricted accounts are omitted and counted (§5.13).

const params = z.object({ dimension: z.enum(DIMENSIONS), nodeId: z.uuid(), from: z.iso.date(), to: z.iso.date(), accountId: z.uuid().optional() });

const columns: ReportColumn[] = [
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true },
  { field: "account_name", label: "report.col.account_name", type: "text" },
  { field: "debit", label: "report.col.debit", type: "money", total: "sum", mono: true },
  { field: "credit", label: "report.col.credit", type: "money", total: "sum", mono: true },
  { field: "net", label: "report.col.net", type: "money", total: "sum", mono: true },
];

export const dimensionDetailConsult = defineProcess({
  id: "accounting.report.dimension_detail",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Auxiliar por dimensión analítica: débito, crédito y neto por cuenta de un nodo (con sus descendientes) de centro de costo, auxiliar abierto, ítem o unidad de negocio",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const def = DIMENSION_DEFS[p.dimension];
    const table = ctx.tx(`accounting.${def.table}`);
    const column = ctx.tx(def.column);
    const [node] = await ctx.tx<{ code: string; name: string }[]>`select code, name from ${table} where id = ${p.nodeId} and company_id = ${ctx.companyId}`;
    if (!node) throw new ProcessError("invalid_input", `${def.entity} ${p.nodeId} not found`, { details: [`No existe el ${def.noun} indicado`] });
    let accountLike: string | null = null;
    if (p.accountId) {
      const [account] = await ctx.tx<{ code: string; visible: boolean }[]>`select code, accounting.can_view_account(id) as visible from accounting.accounts where id = ${p.accountId} and company_id = ${ctx.companyId}`;
      // A missing account answers like a restricted one: the refusal never tells whether an account id exists.
      if (!account || !account.visible) throw new ProcessError("forbidden", "the account is restricted for the caller", { details: ["Sin acceso"] });
      accountLike = `${account.code}%`;
    }
    const tree = ctx.tx`with recursive tree as (
        select id from ${table} where id = ${p.nodeId} and company_id = ${ctx.companyId}
        union all select c.id from ${table} c join tree t on c.parent_id = t.id
      ) select id from tree`;
    const rows = await ctx.tx<{ account_code: string; account_name: string; debit: string; credit: string }[]>`
      select account_code, account_name, sum(debit) as debit, sum(credit) as credit
      from accounting.v_ledger_lines
      where status = 'posted' and date between ${p.from}::date and ${p.to}::date and ${column} in (${tree})
        and (${accountLike}::text is null or account_code like ${accountLike})
      group by account_code, account_name order by account_code`;
    const [raw] = await ctx.tx<{ n: number }[]>`
      with recursive tree as (
        select id from ${table} where id = ${p.nodeId} and company_id = ${ctx.companyId}
        union all select c.id from ${table} c join tree t on c.parent_id = t.id
      )
      select count(*)::int as n from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${ctx.companyId} and e.status = 'posted' and e.date between ${p.from}::date and ${p.to}::date
        and l.${column} in (select id from tree) and (${accountLike}::text is null or a.code like ${accountLike})`;
    const [shown] = await ctx.tx<{ n: number }[]>`
      with recursive tree as (
        select id from ${table} where id = ${p.nodeId} and company_id = ${ctx.companyId}
        union all select c.id from ${table} c join tree t on c.parent_id = t.id
      )
      select count(*)::int as n from accounting.v_ledger_lines
      where status = 'posted' and date between ${p.from}::date and ${p.to}::date and ${column} in (select id from tree)
        and (${accountLike}::text is null or account_code like ${accountLike})`;
    const out = rows.map((r) => ({
      account_code: r.account_code, account_name: r.account_name, debit: cents(Number(r.debit)), credit: cents(Number(r.credit)), net: cents(Number(r.debit) - Number(r.credit)),
    }));
    return windowOf(out, state, { totals: ["debit", "credit", "net"], extra: { omitted: raw!.n - shown!.n, node: `${node.code} · ${node.name}` } });
  },
});

export const dimensionDetailReport = defineReport({
  id: "accounting.dimension_detail",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.dimension_detail",
  params,
  consult: "accounting.report.dimension_detail",
  columns,
  totals: ["debit", "credit", "net"],
  pdfTitle: "Auxiliar por dimensión analítica",
});
