import { defineProcess, defineReport, type ProcessContext, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { companyPack } from "../processes/common";
import { balanceRows, cents, foldRestricted, level, orderedRange, periodBounds, reportInput, reportOutput, RESTRICTED_CODE, RESTRICTED_NAME, windowOf, type BalanceRow } from "./common";

// Estado de resultados (accounting design §6): income and expense by the sections of the pack's layout for a range of periods,
// opening and year-close entries left out. With `byCostCenter` each account repeats per cost center and the cost center totals
// add up to the total; the report page pivots them into columns.

const params = z.object({ from: z.uuid(), to: z.uuid(), byCostCenter: z.boolean().default(false), comparePrevious: z.boolean().default(false), level });
type Params = z.infer<typeof params>;

const columns: ReportColumn[] = [
  { field: "section", label: "report.col.section", type: "text" },
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true, link: { entity: "accounting.account", idField: "account_id" } },
  { field: "account_name", label: "report.col.account_name", type: "text" },
  { field: "cost_center_code", label: "report.col.cost_center", type: "text", mono: true },
  { field: "amount", label: "report.col.amount", type: "money", currency: "company", mono: true },
  { field: "previous", label: "report.col.previous", type: "money", currency: "company", mono: true },
];

/** Section codes of the layout whose natural side is credit; every other section of the statement is an expense. */
export const INCOME_SECTIONS: ReadonlySet<string> = new Set(["revenue", "other_income"]);

const shiftYear = (date: string, by: number) => `${Number(date.slice(0, 4)) + by}${date.slice(4)}`;

async function figures(ctx: ProcessContext, from: string, to: string, lvl: number, byCostCenter: boolean): Promise<BalanceRow[]> {
  return balanceRows(ctx, { from, to, level: lvl, includeOpening: false, includeClosing: false, byCostCenter });
}

export const incomeStatementConsult = defineProcess({
  id: "accounting.report.income_statement",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Estado de resultados de un rango de períodos, opcionalmente por centro de costo y con comparativo del año anterior",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const { from: fromId, to: toId, byCostCenter, comparePrevious, level: lvl } = p as Params;
    const from = await periodBounds(ctx, fromId);
    const to = await periodBounds(ctx, toId);
    orderedRange(from, to);
    const sections = (await companyPack(ctx)).statementLayouts().incomeStatement.map((s) => s.code);
    const current = await figures(ctx, from.startsOn, to.endsOn, lvl, byCostCenter);
    const previous = comparePrevious ? await figures(ctx, shiftYear(from.startsOn, -1), shiftYear(to.endsOn, -1), lvl, byCostCenter) : [];
    const sign = (section: string, r: BalanceRow) => (INCOME_SECTIONS.has(section) ? r.credit - r.debit : r.debit - r.credit);
    const keyOf = (r: BalanceRow) => `${r.code}|${r.costCenterId ?? ""}`;
    const prevByKey = new Map(previous.map((r) => [keyOf(r), r]));

    const rows: Record<string, unknown>[] = [];
    const subtotal = new Map<string, { amount: number; previous: number }>();
    const byCc = new Map<string, number>();
    let restrictedCount = 0;
    for (const section of sections) {
      const own = current.filter((r) => r.section === section);
      const folded = foldRestricted<BalanceRow>(
        own,
        () => ({ nodeId: null, code: RESTRICTED_CODE, name: RESTRICTED_NAME, nature: null, section, restricted: true, openingNet: 0, debit: 0, credit: 0, costCenterId: null, costCenterCode: null, costCenterName: null }),
        (acc, r) => {
          acc.debit += r.debit;
          acc.credit += r.credit;
        },
      );
      let amount = 0;
      let previousTotal = 0;
      const emit = (r: BalanceRow, restricted: boolean, count?: number) => {
        const value = sign(section, r);
        const was = prevByKey.get(keyOf(r));
        const wasValue = was ? sign(section, was) : 0;
        amount += value;
        previousTotal += wasValue;
        // Income adds to the cost center's result, an expense subtracts.
        const cc = r.costCenterCode ?? "";
        byCc.set(cc, (byCc.get(cc) ?? 0) + (INCOME_SECTIONS.has(section) ? value : -value));
        rows.push({
          section, row_kind: restricted ? "restricted" : "detail", account_id: r.nodeId, account_code: r.code, account_name: r.name, cost_center_code: r.costCenterCode ?? "",
          cost_center_name: r.costCenterName ?? "", amount: cents(value), previous: cents(wasValue), ...(count === undefined ? {} : { n: count }),
        });
      };
      for (const r of folded.visible) emit(r, false);
      if (folded.restricted) {
        restrictedCount += folded.count;
        emit(folded.restricted, true, folded.count);
      }
      subtotal.set(section, { amount, previous: previousTotal });
      rows.push({ section, row_kind: "subtotal", account_id: null, account_code: "", account_name: `accounting.statement.${section}`, cost_center_code: "", amount: cents(amount), previous: cents(previousTotal) });
    }
    const net = [...subtotal].reduce((acc, [s, t]) => ({ amount: acc.amount + (INCOME_SECTIONS.has(s) ? t.amount : -t.amount), previous: acc.previous + (INCOME_SECTIONS.has(s) ? t.previous : -t.previous) }), { amount: 0, previous: 0 });
    rows.push({ section: "", row_kind: "result", account_id: null, account_code: "", account_name: "report.net_result", cost_center_code: "", amount: cents(net.amount), previous: cents(net.previous) });
    return windowOf(rows, state, {
      extra: { restricted: restrictedCount, result: cents(net.amount), byCostCenter: Object.fromEntries([...byCc].map(([k, v]) => [k, cents(v)])) },
    });
  },
});

export const incomeStatementReport = defineReport({
  id: "accounting.income_statement",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.income_statement",
  params,
  consult: "accounting.report.income_statement",
  columns,
  pdfTitle: "Estado de resultados",
});
