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

const present = (value: unknown): value is string | number => (typeof value === "string" && value.trim() !== "") || typeof value === "number";

/**
 * The tab title of a record opened from a report row: the clicked cell's value (the account's code) and the row's name
 * for it (`account_name`), never the row's first column, which may be a raw section code (`assets_current`). With
 * `period` (a drill-down's month), tabs of the same account over different ranges read differently.
 */
export function linkTitle(
  row: Record<string, unknown>,
  link: ReportLink,
  report: { columns: readonly { field: string }[]; links: Record<string, { entity: string; idField: string }> },
  fallback: string,
  period?: string,
): string {
  const clicked = report.columns.find((c) => {
    const l = report.links[c.field];
    return l !== undefined && l.entity === link.entity && row[l.idField] === link.id;
  });
  const value = clicked ? row[clicked.field] : undefined;
  const nameField = clicked ? [clicked.field.replace(/code$/, "name"), "name", "label"].find((f) => f !== clicked.field && present(row[f])) : undefined;
  const parts = [value, nameField ? row[nameField] : undefined].filter(present).map(String);
  const title = parts.length > 0 ? parts.join(" · ") : fallback;
  return period ? `${title} · ${period}` : title;
}

/** The range a drill-down href was built for, or undefined. */
export function drillRange(href: string): { from: string; to: string } | undefined {
  try {
    const p = JSON.parse(new URLSearchParams(href.split("?")[1] ?? "").get("p") ?? "{}") as { from?: unknown; to?: unknown };
    return typeof p.from === "string" && typeof p.to === "string" ? { from: p.from, to: p.to } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How a drill-down tab names its range: the month when it is one calendar month ("noviembre de 2026", `month` formats
 * "2026-11"), else the dates ("2026/01/01 – 2026/11/30"), so tabs of one account over different ranges never read alike.
 */
export function rangeLabel(range: { from: string; to: string }, month: (yearMonth: string) => string): string {
  return range.from.slice(0, 7) === range.to.slice(0, 7) ? month(range.to.slice(0, 7)) : `${range.from.replaceAll("-", "/")} – ${range.to.replaceAll("-", "/")}`;
}

/**
 * The Detalle de cartera of a figure of the Cartera por edades (owner 2026-11-11): the aging's parameters, the row's party (none on a
 * currency subtotal) and the clicked bucket («Total» is every bucket the total adds under «Por vencer»); in «Moneda del documento», the row's currency. Null for any other
 * report or column.
 */
export function agingDrillHref(reportId: string, row: Record<string, unknown>, field: string, params: ReportParams): string | null {
  if (reportId !== "accounting.aging" || !AGING_FIELDS.has(field)) return null;
  const partyId = typeof row.party_id === "string" && row.party_id ? row.party_id : undefined;
  const currencyCode = params.currency === "document" && typeof row.currency === "string" ? row.currency : undefined;
  const next: ReportParams = {
    kind: params.kind ?? "receivable",
    ...(params.asOf ? { asOf: params.asOf } : {}),
    ...(params.currency ? { currency: params.currency } : {}),
    ...(params.notDue ? { notDue: params.notDue } : {}),
    ...(partyId ? { partyId } : {}),
    ...(currencyCode ? { currencyCode } : {}),
    bucket: field === "total" ? "all" : field,
  };
  return `/accounting/reports/aging_detail?${paramsToSearch(next)}`;
}

const AGING_FIELDS = new Set(["not_due", "b1", "b2", "b3", "over", "credits", "total"]);
