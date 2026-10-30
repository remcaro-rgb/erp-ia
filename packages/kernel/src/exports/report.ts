import type { Caller } from "../process/context";
import { ProcessError } from "../process/errors";
import { withClaims } from "../db/client";
import { runProcess, type RunProcessDeps } from "../process/run";
import { reportDenial, reportOf } from "../reports/run";
import { ReportState } from "../reports/state";
import type { ReportDef, ReportResult } from "../reports/types";
import { CONTENT_TYPE, exportFileName } from "./file";
import { writeCsv } from "./csv";
import { writeXlsx } from "./xlsx";
import type { ExportPresentation } from "./columns";
import type { RenderedExport } from "./render";
import { EXPORT_PAGE_SIZE, type ExportColumn, type ExportFormat, type ExportRow, type ExportType } from "./types";

// A report turned into a file (design §9, accounting design §10a.5): the same writers as a grid, over the rows of the
// report's consult read in windows of `EXPORT_PAGE_SIZE` as the caller. The PDF's heading carries the book's name, the
// company and its NIT and the parameters; the footer carries "página x de y".

/** What a report export is asked for. */
export interface ReportExportSpec extends ExportPresentation {
  id: string;
  params: unknown;
  format: ExportFormat;
  title?: string;
}

/** Everything a report file is made from: the definition, the caller's consult and the company's heading. */
export interface ReportSource {
  def: ReportDef;
  params: Record<string, unknown>;
  /** One window of the report as the caller (`runReport`); `page` and `pageSize` select it. */
  consult(state: ReportState): Promise<ReportResult>;
  company: string | null;
  taxId: string | null;
  timeZone: string;
  locale?: string;
  /** The parameters as one line under the PDF's title. */
  paramsText?: string;
}

const TYPE: Record<ReportDef["columns"][number]["type"], ExportType> = {
  text: "text",
  number: "number",
  money: "money",
  date: "date",
  datetime: "datetime",
  boolean: "boolean",
  enum: "enum",
  uuid: "text",
  ref: "text",
  json: "json",
};

/** The report's columns as export columns, with the caller's headers and value labels when the screen gave them. */
export function reportExportColumns(def: ReportDef, presentation: ExportPresentation = {}): ExportColumn[] {
  return def.columns.map((column) => {
    const options = presentation.values?.[column.field];
    return { field: column.field, label: presentation.labels?.[column.field] ?? column.label, type: TYPE[column.type], ...(options ? { options } : {}) };
  });
}

/** The lines a report PDF prints above the table. */
export function reportPdfHeader(source: ReportSource): { title: string; company: string | null; taxId: string | null; params: string | undefined } {
  return { title: source.def.pdfTitle ?? source.def.id, company: source.company, taxId: source.taxId, params: source.paramsText };
}

const baseState = (page: number): ReportState => ({ filters: [], sort: [], page, pageSize: EXPORT_PAGE_SIZE });

/** Every row of the report, one window at a time; stops when the total is read or a window comes back short. */
export async function* reportRows(source: ReportSource, state: Partial<ReportState> = {}): AsyncGenerator<ExportRow> {
  for (let page = 1; ; page += 1) {
    const result = await source.consult({ ...baseState(page), ...state, page, pageSize: EXPORT_PAGE_SIZE });
    for (const row of result.rows) yield row;
    if (result.rows.length < EXPORT_PAGE_SIZE || page * EXPORT_PAGE_SIZE >= result.total) return;
  }
}

/** Renders the report in the requested format from `source`. */
export async function renderReportFile(source: ReportSource, spec: ReportExportSpec): Promise<RenderedExport> {
  let written = 0;
  const counted = (async function* () {
    for await (const row of reportRows(source)) {
      written += 1;
      yield row;
    }
  })();
  const columns = reportExportColumns(source.def, spec);
  const header = reportPdfHeader(source);
  const title = spec.title ?? header.title;
  const options = { locale: source.locale, timeZone: source.timeZone };
  const fileName = exportFileName(title, source.def.id, spec.format, source.timeZone);
  const rendered = (body: RenderedExport["body"]): RenderedExport => ({ body, contentType: CONTENT_TYPE[spec.format], fileName, rowCount: () => written });
  switch (spec.format) {
    case "csv":
      return rendered(writeCsv(columns, counted, options));
    case "xlsx":
      return rendered(await writeXlsx(columns, counted, { ...options, title }));
    case "pdf": {
      const { writePdf } = await import("./pdf");
      return rendered(
        await writePdf(columns, counted, {
          ...options,
          title,
          ...(header.company ? { company: header.company } : {}),
          ...(header.taxId ? { taxId: header.taxId } : {}),
          ...(header.params ? { params: header.params } : {}),
          ...(source.def.totals ? { totalFields: source.def.totals } : {}),
        }),
      );
    }
  }
}

/** The parameters as `Nombre: valor` pairs on one line. */
export function paramsLine(params: Record<string, unknown>, labels: Record<string, string> = {}): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${labels[key] ?? key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" · ");
}

/**
 * Resolves a report export as the caller and renders it: the report must exist and the caller be entitled and allowed
 * its consult; the parameters must satisfy its schema. Throws `ProcessError` (`not_found`, `not_entitled`, `forbidden`,
 * `invalid_input`). Each window is a run of the consult, audited on the caller's chain.
 */
export async function openReportExport(deps: RunProcessDeps, caller: Caller, spec: ReportExportSpec): Promise<RenderedExport> {
  const def = reportOf(deps, spec.id);
  if (!def) throw new ProcessError("not_found", `unknown report ${spec.id}`);
  const denial = await reportDenial(deps, caller.claims, def);
  if (denial) throw new ProcessError(denial, `${def.id}: ${denial}`);
  const parsed = def.params.safeParse(spec.params ?? {});
  if (!parsed.success) throw new ProcessError("invalid_input", `invalid parameters for report ${def.id}`, { details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const params = parsed.data as Record<string, unknown>;
  const [company] = await withClaims(deps.sql, caller.claims, (tx) =>
    tx<{ legal_name: string; tax_id: string | null; timezone: string }[]>`select legal_name, tax_id, timezone from kernel.companies where id = kernel.current_company_id()`,
  );
  const source: ReportSource = {
    def,
    params,
    consult: (state) => runProcess<never>(deps, caller, def.consult, { params, state }) as Promise<ReportResult>,
    company: company?.legal_name ?? null,
    taxId: company?.tax_id ?? null,
    timeZone: company?.timezone ?? "America/Bogota",
    locale: caller.claims.locale,
    paramsText: paramsLine(params, spec.labels),
  };
  return renderReportFile(source, spec);
}
