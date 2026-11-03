import { defineProcess, defineReport, ProcessError, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { companyPack } from "../processes/common";
import { cents, orderedRange, periodBounds, reportInput, reportOutput, RESTRICTED_CODE, windowOf } from "./common";
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
    // The whole tree, readable or not (a security-definer source, 0046), so a group adds up every descendant whoever looks (D11);
    // the code and name of the readable nodes come from the table under the caller's RLS.
    const tree = await ctx.tx<{ id: string; parent_id: string | null; readable: boolean }[]>`select id, parent_id, readable from accounting.master_tree('cost_center')`;
    const named = new Map(
      (await ctx.tx<{ id: string; code: string; name: string }[]>`select id, code, name from accounting.cost_centers where company_id = ${ctx.companyId}`).map((n) => [n.id, n]),
    );
    const readable = (id: string) => named.has(id) && tree.some((n) => n.id === id && n.readable);
    // A node the caller cannot read is refused exactly as one that does not exist.
    if (p.nodeId && !readable(p.nodeId)) throw new ProcessError("invalid_input", "unknown cost center", { details: ["El centro de costo indicado no existe"] });
    const sums = await ctx.tx<{ cost_center_id: string | null; section: string; debit: string; credit: string }[]>`
      select cost_center_id, statement_section as section, debit, credit from accounting.cost_center_sums(${from.startsOn}::date, ${to.endsOn}::date, ${incomeSections}::text[])`;
    const own = new Map<string | null, { income: number; expense: number }>();
    for (const s of sums) {
      const entry = own.get(s.cost_center_id) ?? { income: 0, expense: 0 };
      if (INCOME_SECTIONS.has(s.section)) entry.income += Number(s.credit) - Number(s.debit);
      else entry.expense += Number(s.debit) - Number(s.credit);
      own.set(s.cost_center_id, entry);
    }
    type Node = { id: string; parent_id: string | null; readable: boolean };
    const children = new Map<string | null, Node[]>();
    for (const n of tree) children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n]);
    const memo = new Map<string, { income: number; expense: number }>();
    const total = (id: string): { income: number; expense: number } => {
      const known = memo.get(id);
      if (known) return known;
      const mine = own.get(id) ?? { income: 0, expense: 0 };
      const sum = (children.get(id) ?? []).reduce((acc, c) => ({ income: acc.income + total(c.id).income, expense: acc.expense + total(c.id).expense }), { ...mine });
      memo.set(id, sum);
      return sum;
    };
    const rows: Record<string, unknown>[] = [];
    const line = (id: string | null, code: string, name: string, depth: number, t: { income: number; expense: number }) =>
      rows.push({ cost_center_id: id, cost_center_code: code, cost_center_name: name, depth, income: cents(t.income), expense: cents(t.expense), net: cents(t.income - t.expense) });
    // The readable children of `parent` by code, each with its subtree; the ones the caller cannot read folded into one lock line at
    // that depth that names none of them (review I7), followed by their readable descendants.
    const walk = (parent: string | null, depth: number) => {
      const kids = children.get(parent) ?? [];
      const shown = kids.filter((k) => readable(k.id)).sort((a, b) => named.get(a.id)!.code.localeCompare(named.get(b.id)!.code));
      const hidden = kids.filter((k) => !readable(k.id));
      for (const node of shown) {
        const info = named.get(node.id)!;
        line(node.id, info.code, info.name, depth, total(node.id));
        walk(node.id, depth + 1);
      }
      if (hidden.length > 0) {
        const folded = hidden.reduce((acc, k) => ({ income: acc.income + total(k.id).income, expense: acc.expense + total(k.id).expense }), { income: 0, expense: 0 });
        line(null, RESTRICTED_CODE, "report.restricted_cost_centers", depth, folded);
        for (const k of hidden) walk(k.id, depth + 1);
      }
    };
    if (p.nodeId) {
      const info = named.get(p.nodeId)!;
      line(info.id, info.code, info.name, 0, total(p.nodeId));
      walk(p.nodeId, 1);
    } else {
      walk(null, 0);
      const none = own.get(null);
      if (none) line(null, "", "report.no_cost_center", 0, none);
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
