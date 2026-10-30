import { defineProcess, defineReport, ProcessError, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { companyPack } from "../processes/common";
import { cents, orderedRange, periodBounds, reportInput, reportOutput, windowOf } from "./common";
import { INCOME_SECTIONS } from "./income-statement";

// Resultados por centro de costo (accounting design §6): income and expense of each node of the cost center tree, a group adding
// up its descendants. Lines with no cost center close the list. Opening and year-close entries are left out.

const params = z.object({ from: z.uuid(), to: z.uuid(), nodeId: z.uuid().optional() });

const columns: ReportColumn[] = [
  { field: "cost_center_code", label: "report.col.cost_center", type: "text", mono: true },
  { field: "cost_center_name", label: "report.col.cost_center_name", type: "text" },
  { field: "income", label: "report.col.income", type: "money", total: "sum", mono: true },
  { field: "expense", label: "report.col.expense", type: "money", total: "sum", mono: true },
  { field: "net", label: "report.col.net", type: "money", total: "sum", mono: true },
];

export const costCenterStatementConsult = defineProcess({
  id: "accounting.report.cost_center_statement",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Ingresos y gastos por centro de costo en un rango de períodos; cada grupo suma a sus descendientes",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const from = await periodBounds(ctx, p.from);
    const to = await periodBounds(ctx, p.to);
    orderedRange(from, to);
    const incomeSections = (await companyPack(ctx)).statementLayouts().incomeStatement.map((s) => s.code);
    const nodes = await ctx.tx<{ id: string; parent_id: string | null; code: string; name: string }[]>`
      select id, parent_id, code, name from accounting.cost_centers where company_id = ${ctx.companyId} order by code`;
    if (p.nodeId && !nodes.some((n) => n.id === p.nodeId)) throw new ProcessError("invalid_input", "unknown cost center", { details: ["El centro de costo indicado no existe"] });
    const sums = await ctx.tx<{ cost_center_id: string | null; section: string; debit: string; credit: string }[]>`
      select l.cost_center_id, a.statement_section as section, sum(l.debit) as debit, sum(l.credit) as credit
      from accounting.entry_lines l
      join accounting.entries e on e.id = l.entry_id
      join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and not e.is_opening and not e.is_closing
        and e.date between ${from.startsOn}::date and ${to.endsOn}::date and a.statement_section = any(${incomeSections}::text[])
      group by l.cost_center_id, a.statement_section`;
    const own = new Map<string | null, { income: number; expense: number }>();
    for (const s of sums) {
      const entry = own.get(s.cost_center_id) ?? { income: 0, expense: 0 };
      if (INCOME_SECTIONS.has(s.section)) entry.income += Number(s.credit) - Number(s.debit);
      else entry.expense += Number(s.debit) - Number(s.credit);
      own.set(s.cost_center_id, entry);
    }
    type Node = { id: string; parent_id: string | null; code: string; name: string };
    const children = new Map<string | null, Node[]>();
    for (const n of nodes) children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n]);
    const total = (id: string): { income: number; expense: number } => {
      const mine = own.get(id) ?? { income: 0, expense: 0 };
      return (children.get(id) ?? []).reduce((acc, c) => ({ income: acc.income + total(c.id).income, expense: acc.expense + total(c.id).expense }), { ...mine });
    };
    const rows: Record<string, unknown>[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const node of children.get(parent) ?? []) {
        const t = total(node.id);
        rows.push({ cost_center_id: node.id, cost_center_code: node.code, cost_center_name: node.name, depth, income: cents(t.income), expense: cents(t.expense), net: cents(t.income - t.expense) });
        walk(node.id, depth + 1);
      }
    };
    if (p.nodeId) {
      const root = nodes.find((n) => n.id === p.nodeId)!;
      const t = total(root.id);
      rows.push({ cost_center_id: root.id, cost_center_code: root.code, cost_center_name: root.name, depth: 0, income: cents(t.income), expense: cents(t.expense), net: cents(t.income - t.expense) });
      walk(root.id, 1);
    } else {
      walk(null, 0);
      const none = own.get(null);
      if (none) rows.push({ cost_center_id: null, cost_center_code: "", cost_center_name: "report.no_cost_center", depth: 0, income: cents(none.income), expense: cents(none.expense), net: cents(none.income - none.expense) });
    }
    // Totals count top-level rows only: a group already holds its descendants.
    return windowOf(rows, state, { totals: ["income", "expense", "net"], isDetail: (r) => r.depth === 0 });
  },
});

export const costCenterStatementReport = defineReport({
  id: "accounting.cost_center_statement",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.cost_center_statement",
  params,
  consult: "accounting.report.cost_center_statement",
  columns,
  totals: ["income", "expense", "net"],
  pdfTitle: "Resultados por centro de costo",
});
