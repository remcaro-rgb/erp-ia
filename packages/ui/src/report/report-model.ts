import { GridFetchError, detailsOf } from "../grid/fetch-grid";
import type { GridColumn, GridFetcher, GridPage } from "../grid/types";

// A report is a parameter bar over a grid (design §9, accounting design §10a.5). The server turns the report's zod
// schema into `ParamSpec`s (a zod schema does not cross to the browser); this file holds what the page does with them.

export type ParamValue = string | number | boolean | null;
export type ReportParams = Record<string, ParamValue>;

export interface ParamSpec {
  name: string;
  /** Translated label of the control. */
  label: string;
  type: "date" | "enum" | "ref" | "boolean" | "number" | "text";
  /** Values of an enum or a reference, with their labels. */
  options?: { value: string; label: string }[];
  required?: boolean;
  /** An integer `number` with a short range (the `level` 1–8) is a select. */
  min?: number;
  max?: number;
}

/** What the browser needs of a `ReportDef`: columns translated and with the caller's field modes, the params as specs. */
export interface ReportDefClient {
  id: string;
  label: string;
  params: ParamSpec[];
  /** Parameters not offered: dimension selects whose `use_*` company setting is off. */
  hiddenParams: string[];
  columns: GridColumn[];
  /** Columns the footer totals. */
  totals: string[];
  /** A column that links to a record of another entity (rule 21): `idField` of the row holds its id. */
  links: Record<string, { entity: string; idField: string }>;
  /** Files the page offers next to the exports (the exógena's XML): the button label translated. */
  fileActions: { id: string; label: string }[];
  /** The open period, for the quick range "Este período"; the calendar month of today when absent. */
  period?: { from: string; to: string };
}

export interface DateRange {
  from: string;
  to: string;
}

/** The widest integer range a `number` parameter still gets a select for. */
export const SELECT_MAX_SPAN = 12;

export const visibleParams = (report: Pick<ReportDefClient, "params" | "hiddenParams">): ParamSpec[] => report.params.filter((p) => !report.hiddenParams.includes(p.name));

export const asSelect = (spec: ParamSpec): boolean =>
  spec.type === "number" && spec.min !== undefined && spec.max !== undefined && Number.isInteger(spec.min) && Number.isInteger(spec.max) && spec.max - spec.min < SELECT_MAX_SPAN;

/** The quick ranges (`Hoy · Este período · Este año`) exist when the schema has `from` and `to` dates. */
export const hasDateRange = (params: readonly ParamSpec[]): boolean => params.some((p) => p.name === "from" && p.type === "date") && params.some((p) => p.name === "to" && p.type === "date");

const pad = (n: number) => String(n).padStart(2, "0");

/** `today` is `YYYY-MM-DD`; `period` is the open period, else the calendar month of today. */
export function quickRanges(today: string, period?: DateRange): { today: DateRange; period: DateRange; year: DateRange } {
  const [year, month] = today.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    today: { from: today, to: today },
    period: period ?? { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` },
    year: { from: `${year}-01-01`, to: `${year}-12-31` },
  };
}

/** Today in `timeZone` as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const PARAM = "p";

/** The parameters as a query string (`p=<json>`, no leading `?`); unset ones are left out. */
export function paramsToSearch(params: ReportParams): string {
  const set = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  return Object.keys(set).length === 0 ? "" : new URLSearchParams({ [PARAM]: JSON.stringify(set) }).toString();
}

/** The parameters of a query string (with or without `?`); anything that is not a JSON object of scalars is no parameters. */
export function paramsFromSearch(search: string): ReportParams {
  const raw = new URLSearchParams(search).get(PARAM);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))) as ReportParams;
  } catch {
    return {};
  }
}

/** The fetcher of a report's grid: POST /api/report/<id> with the parameters and the grid state (design §9). */
export function reportFetcher(id: string, params: ReportParams, endpoint = "/api/report"): GridFetcher {
  return async (state, signal) => {
    const response = await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params, state }),
      signal,
    });
    const body = (await response.json().catch(() => null)) as (GridPage & { code?: string; details?: unknown }) | null;
    if (!response.ok || !body) throw new GridFetchError(body?.code ?? "handler_failed", response.status, detailsOf(body?.details));
    return body;
  };
}
