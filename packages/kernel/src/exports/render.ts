import type { Sql } from "postgres";
import { withClaims, type JwtClaims } from "../db/client";
import type { Registry } from "../registry";
import { writeCsv } from "./csv";
import { CONTENT_TYPE, exportFileName } from "./file";
import { groupedColumns, groupedRows, GROUP_FIELD } from "./grouped";
import { exportRows, planExport, type ExportPlan, type ExportSpec } from "./plan";
import { writeXlsx } from "./xlsx";

// An export turned into a file (design §9). The same code serves the request that answers inline and the workflow of
// a job: it plans as the caller, reads the rows page by page and hands them to the format's writer.

export interface RenderedExport {
  /** A stream for CSV (the rows are read as it is consumed); the bytes for Excel and PDF. */
  body: ReadableStream<Uint8Array> | Buffer;
  contentType: string;
  fileName: string;
  /** Rows written so far; the whole count once the body has been consumed. */
  rowCount(): number;
}

/** Renders `spec` for the caller from an already resolved plan. */
export async function renderExport(sql: Sql, claims: JwtClaims, plan: ExportPlan, spec: ExportSpec): Promise<RenderedExport> {
  let written = 0;
  const counted = (async function* () {
    for await (const row of exportRows(sql, claims, plan)) {
      written += 1;
      yield row;
    }
  })();
  const locale = claims.locale;
  const options = { locale, timeZone: plan.access.timeZone };
  const fileName = exportFileName(spec.title, spec.entity, spec.format, plan.access.timeZone);
  const rendered = (body: RenderedExport["body"]): RenderedExport => ({ body, contentType: CONTENT_TYPE[spec.format], fileName, rowCount: () => written });
  // A grouped state (grouped.ts) prints the group path first, a subtotal after each group and the grand total last.
  const columns = plan.grouped ? groupedColumns(plan.columns, { ...options, ...(spec.labels?.[GROUP_FIELD] ? { label: spec.labels[GROUP_FIELD] } : {}) }) : plan.columns;
  const lines = plan.grouped ? groupedRows(counted, plan.grouped, options) : counted;
  switch (spec.format) {
    case "csv":
      return rendered(writeCsv(columns, lines, options));
    case "xlsx":
      return rendered(await writeXlsx(columns, lines, { ...options, ...(spec.title ? { title: spec.title } : {}) }));
    case "pdf": {
      // Loaded on demand: the PDF engine is large and only this format needs it.
      const { writePdf } = await import("./pdf");
      return rendered(await writePdf(columns, lines, { ...options, ...(spec.title ? { title: spec.title } : {}), ...(plan.company ? { company: plan.company } : {}) }));
    }
  }
}

/** Plans (as the caller, in one transaction) and renders `spec`: the file the caller would get from the grid's state. */
export async function openExport(sql: Sql, registry: Registry, claims: JwtClaims, spec: ExportSpec): Promise<RenderedExport & { plan: ExportPlan }> {
  const plan = await withClaims(sql, claims, (tx) => planExport(tx, registry, spec));
  return { ...(await renderExport(sql, claims, plan, spec)), plan };
}
