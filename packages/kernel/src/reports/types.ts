import type { z } from "zod";
import type { FieldType } from "../registry/fields";

// A report is a parameter bar over a consult process (design §9, accounting design §10a.5): the kernel knows the
// definition, never the module's tables. The consult returns the rows of one window of the report, as a grid does.

export interface ReportColumn {
  field: string;
  /** Header: an i18n key on screen, the plain text in a file when the caller's catalogue has no such key. */
  label: string;
  type: FieldType;
  /** The footer sums this column over the whole filter (from the consult's `aggregates`). */
  total?: "sum";
  mono?: boolean;
  /**
   * Whose currency a money column's figures are in (FX §7, check:rules «report-currency»): the company's, or the ISO code a field of each
   * row holds. No report adds two currencies into one figure.
   */
  currency?: "company" | { field: string };
  /** The cell links to a record of another entity (rule 21): `idField` of the row holds its id. */
  link?: { entity: string; idField: string };
  /** A non-empty figure of the column opens the detail behind it (the aging's drill-down, owner 2026-11-11); the app decides where. */
  drill?: boolean;
}

/**
 * A file a report page offers next to its export buttons: a consult process of the report's feature that writes a
 * document from the report's parameters (the exógena's XML). The route stores the document in the exports store and
 * answers a signed link; the process, not the route, decides what is refused (permission, step-up, its own errors).
 */
export interface ReportFileAction {
  /** `[a-z][a-z0-9_]*`, unique in the report; the route is `/api/report/<report>/file/<id>`. */
  id: string;
  /** i18n key of the button. */
  label: string;
  /** Consult process id: input the report's parameters, output `{ fileName: string, [contentField]: string }`. */
  process: string;
  contentType: string;
  /** The field of the process's output that holds the document's text. */
  contentField: string;
}

export interface ReportDef<P extends z.ZodObject = z.ZodObject> {
  /** `<module>.<name>`, e.g. `accounting.trial_balance`. */
  id: string;
  module: string;
  /** Feature id of the module the company must be entitled to. */
  feature: string;
  /** i18n key `report.<id>`. */
  label: string;
  /** The parameter bar is generated from it (date, enum, ref, boolean, number). */
  params: P;
  /** Consult process id: input `{ params: z.infer<P>; state: ReportState }`, output `ReportResult`. */
  consult: string;
  columns: ReportColumn[];
  /** Columns the footer totals (sum over the whole filter, from `aggregates`). */
  totals?: string[];
  /** Files the page offers besides the PDF / Excel / CSV exports. */
  fileActions?: ReportFileAction[];
  /** PDF header: the book's name; the company, NIT, parameters and "página x de y" are added by the writer. */
  pdfTitle?: string;
}

export interface ReportResult {
  rows: Record<string, unknown>[];
  total: number;
  aggregates?: Record<string, unknown>;
}
