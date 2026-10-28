// The model the three export writers share (design §9, rule 20): the columns the caller sees, in the order the grid
// shows them, and rows keyed by column field. Plain data: nothing here knows a module or a format.

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** How a column's values are typed in a file: dates stay dates and money stays a number in Excel. */
export type ExportType = "text" | "number" | "money" | "date" | "datetime" | "boolean" | "enum" | "json";

export interface ExportColumn {
  /** Registry field, or `extra.<key>` for an admin-defined field. */
  field: string;
  /** The header, in the user's language. */
  label: string;
  type: ExportType;
  /** The caller sees this column masked (rule 14): every cell prints `••••••`, whatever the row holds. */
  masked?: boolean;
  /** Value → label (enums, booleans, references), as the grid shows them. */
  options?: Record<string, string>;
}

/** One row, keyed by `ExportColumn.field`. Database values: numerics as strings, timestamps as `Date`. */
export type ExportRow = Record<string, unknown>;

/** Rows in memory or paged in lazily: the writers read them once, in order. */
export type RowSource = Iterable<ExportRow> | AsyncIterable<ExportRow>;

export interface WriterOptions {
  /** `es-419` (default) or `en`: the CSV separator, the decimal mark, Sí / No. */
  locale?: string;
  /** IANA zone of the company: a timestamp is written as the wall clock there. */
  timeZone?: string;
}

/** Rows are read in pages of this many from the database (design §9). */
export const EXPORT_PAGE_SIZE = 1000;

/** From this many rows an export runs as a durable job instead of answering the request (design §9). */
export const EXPORT_INLINE_LIMIT = 10_000;

/**
 * A PDF is laid out in memory (about 150 MB of heap per 1,000 rows): beyond this many rows a request does not render it
 * itself but starts a job (CSV and Excel keep `EXPORT_INLINE_LIMIT`, they are streamed).
 */
export const EXPORT_PDF_INLINE_LIMIT = 2_000;

/** Beyond this many rows a PDF is refused (`pdf_too_large`: Excel and CSV take any size). */
export const EXPORT_PDF_MAX_ROWS = 10_000;
