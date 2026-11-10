import { defineProcess, defineReport, type ProcessContext, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { companyPack } from "../processes/common";
import { balanceRows, cents, foldRestricted, level, periodBounds, reportInput, reportOutput, RESTRICTED_CODE, RESTRICTED_NAME, windowOf, type BalanceRow } from "./common";

// Estado de situación financiera (accounting design §6): the balance sheet at the end of a period, by the sections of the pack's
// layout, with the result of the period still open on the income accounts shown in equity so assets = liabilities + equity.

const params = z.object({ asOfPeriod: z.uuid(), comparePrevious: z.boolean().default(true), level });
type Params = z.infer<typeof params>;

const columns: ReportColumn[] = [
  { field: "section", label: "report.col.section", type: "text" },
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true, link: { entity: "accounting.account", idField: "account_id" } },
  { field: "account_name", label: "report.col.account_name", type: "text" },
  { field: "amount", label: "report.col.amount", type: "money", currency: "company", mono: true },
  { field: "previous", label: "report.col.previous", type: "money", currency: "company", mono: true },
];

const ASSETS = new Set(["assets_current", "assets_noncurrent"]);
const LIABILITIES = new Set(["liabilities_current", "liabilities_noncurrent"]);

interface Net {
  row: BalanceRow;
  net: number;
}

async function snapshot(ctx: ProcessContext, asOf: string, lvl: number): Promise<BalanceRow[]> {
  // Everything up to the date is the "opening" of a range that starts after it.
  return balanceRows(ctx, { from: "9999-12-31", to: asOf, level: lvl, includeOpening: true, includeClosing: true });
}

export const balanceSheetConsult = defineProcess({
  id: "accounting.report.balance_sheet",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Estado de situación financiera al cierre de un período, con comparativo del cierre del año anterior; las cuentas restringidas se suman en una línea",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const { asOfPeriod, comparePrevious, level: lvl } = p as Params;
    const period = await periodBounds(ctx, asOfPeriod);
    const layout = (await companyPack(ctx)).statementLayouts().balanceSheet.map((s) => s.code);
    const [year] = await ctx.tx<{ year: number }[]>`select year from accounting.fiscal_years where id = ${period.fiscalYearId}`;
    const [prior] = comparePrevious
      ? await ctx.tx<{ ends_on: string }[]>`select ends_on::text from accounting.fiscal_years where company_id = ${ctx.companyId} and year = ${year!.year - 1}`
      : [];
    const current = await snapshot(ctx, period.endsOn, lvl);
    const previous = prior ? await snapshot(ctx, prior.ends_on, lvl) : [];

    const key = (r: BalanceRow) => r.code;
    const prevByCode = new Map(previous.map((r) => [key(r), r]));
    const sign = (section: string, net: number) => (ASSETS.has(section) ? net : -net);
    const rows: Record<string, unknown>[] = [];
    const sectionTotals = new Map<string, { amount: number; previous: number }>();
    let restrictedCount = 0;


    // The result of the year still open on the income accounts (credit positive: a profit).
    const incomeNet = (all: BalanceRow[]) => all.filter((r) => r.section !== null && !layout.includes(r.section) && r.section !== "result").reduce((sum, r) => sum + r.openingNet, 0);
    const result = { amount: -incomeNet(current), previous: -incomeNet(previous) };
    for (const section of layout) {
      const own = current.filter((r) => r.section === section);
      const ownPrev = previous.filter((r) => r.section === section);
      const folded = foldRestricted<Net & { restricted: boolean }>(
        own.map((row) => ({ row, net: row.openingNet, restricted: row.restricted })),
        () => ({ row: { nodeId: null, code: RESTRICTED_CODE, name: RESTRICTED_NAME, nature: null, section, restricted: true, openingNet: 0, debit: 0, credit: 0 }, net: 0, restricted: true }),
        (acc, r) => void (acc.net += r.net),
      );
      const hiddenPrev = ownPrev.filter((r) => r.restricted).reduce((sum, r) => sum + r.openingNet, 0);
      let amount = 0;
      let previousTotal = 0;
      for (const item of folded.visible) {
        const was = prevByCode.get(key(item.row))?.openingNet ?? 0;
        amount += sign(section, item.net);
        previousTotal += sign(section, was);
        rows.push({ section, row_kind: "detail", account_id: item.row.nodeId, account_code: item.row.code, account_name: item.row.name, amount: cents(sign(section, item.net)), previous: cents(sign(section, was)) });
      }
      if (folded.restricted) {
        restrictedCount += folded.count;
        amount += sign(section, folded.restricted.net);
        previousTotal += sign(section, hiddenPrev);
        rows.push({ section, row_kind: "restricted", account_id: null, account_code: RESTRICTED_CODE, account_name: RESTRICTED_NAME, n: folded.count, amount: cents(sign(section, folded.restricted.net)), previous: cents(sign(section, hiddenPrev)) });
      }
      // Accounts of the section that existed a year ago and have no balance now still belong to the comparative.
      const seen = new Set(own.map(key));
      for (const old of ownPrev.filter((r) => !r.restricted && !seen.has(key(r)))) {
        previousTotal += sign(section, old.openingNet);
        rows.push({ section, row_kind: "detail", account_id: old.nodeId, account_code: old.code, account_name: old.name, amount: 0, previous: cents(sign(section, old.openingNet)) });
      }
      if (section === "equity") {
        rows.push({ section, row_kind: "result", account_id: null, account_code: "", account_name: "report.period_result", amount: cents(result.amount), previous: cents(result.previous) });
        amount += result.amount;
        previousTotal += result.previous;
      }
      sectionTotals.set(section, { amount, previous: previousTotal });
      rows.push({ section, row_kind: "subtotal", account_id: null, account_code: "", account_name: `accounting.statement.${section}`, amount: cents(amount), previous: cents(previousTotal) });
    }

    const sum = (set: Set<string>) => [...sectionTotals].filter(([s]) => set.has(s)).reduce((acc, [, t]) => ({ amount: acc.amount + t.amount, previous: acc.previous + t.previous }), { amount: 0, previous: 0 });
    const assets = sum(ASSETS);
    const liabilities = sum(LIABILITIES);
    const equity = sectionTotals.get("equity") ?? { amount: 0, previous: 0 };
    const footer = (row_kind: string, name: string, t: { amount: number; previous: number }) =>
      rows.push({ section: "", row_kind, account_id: null, account_code: "", account_name: name, amount: cents(t.amount), previous: cents(t.previous) });
    footer("total_assets", "report.total_assets", assets);
    footer("total_liabilities", "report.total_liabilities", liabilities);
    footer("total_equity", "report.total_equity", equity);
    footer("difference", "report.difference", { amount: assets.amount - liabilities.amount - equity.amount, previous: assets.previous - liabilities.previous - equity.previous });
    return windowOf(rows, state, {
      extra: {
        restricted: restrictedCount, assets: cents(assets.amount), liabilities: cents(liabilities.amount), equity: cents(equity.amount), result: cents(result.amount),
        difference: cents(assets.amount - liabilities.amount - equity.amount), asOf: period.endsOn,
      },
    });
  },
});

export const balanceSheetReport = defineReport({
  id: "accounting.balance_sheet",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.balance_sheet",
  params,
  consult: "accounting.report.balance_sheet",
  columns,
  pdfTitle: "Estado de situación financiera",
});
