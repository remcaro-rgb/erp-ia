import "server-only";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { ProcessError, reportDenial, reportOf, runProcess, type Caller, type ReportColumn, type ReportDef } from "@erp/kernel";
import { filterKind } from "@erp/kernel/query";
import type { GridColumn, ParamSpec, ReportDefClient, ReportParams, SavedViewItem } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";

// What a report page needs, read as the caller (design §9, accounting design §10a.5): the report with its columns
// translated and its parameters as specs, the caller's saved parameter sets and the default parameters.

export type ReportDenialCode = "not_found" | "not_entitled" | "forbidden";

export interface ReportPageData {
  report: ReportDefClient;
  /** The parameters the schema defaults to; the URL's (`?p=`) go over them. */
  defaults: ReportParams;
  views: SavedViewItem[];
  /** Dates of the periods a report names by id (the account of a statement row opens the Auxiliar for that range). */
  periodDates: Record<string, { from: string; to: string }>;
}

export interface LoadReportOptions {
  /** Dimension parameters not offered: their `use_*` company setting is off. */
  hiddenParams?: string[];
  /** Values of the enum / reference parameters the schema cannot list (accounts, journals, cost centers). */
  paramOptions?: Record<string, { value: string; label: string }[]>;
  /** The open period, for "Este período". */
  period?: { from: string; to: string };
  /** Values the parameter bar starts on over the schema's own defaults (the current period, today); the URL's `?p=` still goes over them. */
  defaults?: ReportParams;
  /** Date range of each period id offered in the bar. */
  periodDates?: Record<string, { from: string; to: string }>;
}

export type ReportPageResult = { ok: true; data: ReportPageData } | { ok: false; denial: ReportDenialCode };

type Translate = (key: string) => string;

interface PropertySchema {
  type?: string;
  format?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

const isScalar = (v: unknown): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v);

/** The parameter bar of a report's schema: one spec per property, in the schema's order. */
export function paramSpecs(def: ReportDef, t: Translate, has: (key: string) => boolean, options: LoadReportOptions["paramOptions"] = {}): { specs: ParamSpec[]; defaults: ReportParams } {
  const json = z.toJSONSchema(def.params, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, PropertySchema>; required?: string[] };
  const required = new Set(json.required ?? []);
  // Parameter names are camelCase in the schema, catalogue keys snake_case (`costCenterId` → `report.param.cost_center_id`).
  const label = (name: string) => {
    const key = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    return has(`report.param.${def.id}.${key}`) ? t(`report.param.${def.id}.${key}`) : has(`report.param.${key}`) ? t(`report.param.${key}`) : name;
  };
  const defaults: ReportParams = {};
  const specs = Object.entries(json.properties ?? {}).map(([name, p]): ParamSpec => {
    if (isScalar(p.default)) defaults[name] = p.default;
    const base = { name, label: label(name), ...(required.has(name) ? { required: true } : {}) };
    const listed = options[name];
    if (listed) return { ...base, type: p.enum ? "enum" : "ref", options: listed };
    if (p.enum) return { ...base, type: "enum", options: p.enum.filter(isScalar).map((value) => ({ value: String(value), label: has(`report.enum.${def.id}.${name}.${value}`) ? t(`report.enum.${def.id}.${name}.${value}`) : String(value) })) };
    if (p.type === "boolean") return { ...base, type: "boolean" };
    if (p.type === "number" || p.type === "integer") return { ...base, type: "number", ...(p.minimum !== undefined ? { min: p.minimum } : {}), ...(p.maximum !== undefined ? { max: p.maximum } : {}) };
    if (p.format === "date") return { ...base, type: "date" };
    return { ...base, type: "text" };
  });
  return { specs, defaults };
}

function gridColumn(column: ReportColumn, t: Translate, has: (key: string) => boolean): GridColumn {
  return {
    field: column.field,
    label: has(column.label) ? t(column.label) : column.label,
    type: column.type,
    kind: filterKind(column.type),
    mode: "visible",
    filterable: true,
    sortable: true,
    ...(column.mono ? { display: "mono" as const } : {}),
  };
}

/** The caller's saved parameter sets of the report; none when their role may not list them. */
async function savedSets(caller: Caller, id: string): Promise<SavedViewItem[]> {
  try {
    return await runProcess(processDeps(), caller, "kernel.saved_view.list", { entity: `report:${id}` });
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return [];
    throw error;
  }
}

/** The page data of report `id`, or why the caller may not open it. */
export async function loadReportPage(id: string, options: LoadReportOptions = {}): Promise<ReportPageResult> {
  const caller = await requireCaller();
  const deps = processDeps();
  const def = reportOf(deps, id);
  if (!def) return { ok: false, denial: "not_found" };
  const denial = await reportDenial(deps, caller.claims, def);
  if (denial) return { ok: false, denial };

  const [t, views] = await Promise.all([getTranslations(), savedSets(caller, id)]);
  const has = (key: string) => t.has(key as never);
  const translate: Translate = (key) => t(key as never);
  const { specs, defaults } = paramSpecs(def, translate, has, options.paramOptions);
  const columns = def.columns;
  return {
    ok: true,
    data: {
      report: {
        id: def.id,
        label: has(def.label) ? translate(def.label) : def.label,
        params: specs,
        hiddenParams: options.hiddenParams ?? [],
        columns: columns.map((c) => gridColumn(c, translate, has)),
        totals: def.totals ?? [],
        fileActions: (def.fileActions ?? []).map((a) => ({ id: a.id, label: has(a.label) ? translate(a.label) : a.label })),
        links: Object.fromEntries(columns.filter((c) => c.link).map((c) => [c.field, c.link!])),
        ...(options.period ? { period: options.period } : {}),
      },
      defaults: { ...defaults, ...(options.defaults ?? {}) },
      views,
      periodDates: options.periodDates ?? {},
    },
  };
}
