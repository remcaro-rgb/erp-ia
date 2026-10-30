import { paramsToSearch, type ReportLink, type ReportParams } from "@erp/ui";

// Where a click on a report row leads (accounting design §8, journey 7): the account of a statement row opens the Auxiliar por cuenta
// for the range the statement was run on, in its own tab. Any other link opens the record of the entity it names (rule 21).

const STATEMENTS = new Set(["accounting.trial_balance", "accounting.ledger", "accounting.balance_sheet", "accounting.income_statement", "accounting.cost_center_statement"]);
/** The period parameters of the statements, by name. */
const PERIOD_RANGES: Record<string, { from: string; to: string }> = {
  "accounting.trial_balance": { from: "from", to: "to" },
  "accounting.income_statement": { from: "from", to: "to" },
  "accounting.cost_center_statement": { from: "from", to: "to" },
  "accounting.ledger": { from: "period", to: "period" },
  "accounting.balance_sheet": { from: "asOfPeriod", to: "asOfPeriod" },
};

/** The page to open for `link` of a row of report `reportId` run with `params`, or null to open the linked record. */
export function drillHref(
  reportId: string,
  link: ReportLink,
  params: ReportParams,
  periodDates: Record<string, { from: string; to: string }>,
): string | null {
  if (!STATEMENTS.has(reportId) || link.entity !== "accounting.account") return null;
  const names = PERIOD_RANGES[reportId]!;
  const from = periodDates[String(params[names.from] ?? "")]?.from;
  const to = periodDates[String(params[names.to] ?? "")]?.to;
  if (!from || !to) return null;
  return `/accounting/reports/account_detail?${paramsToSearch({ accountId: link.id, from, to })}`;
}
