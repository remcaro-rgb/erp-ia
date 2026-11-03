import { ProcessError } from "../process/errors";
import type { ImportColumn, ImportLines } from "./columns";
import { columnLabel, lineLabels, linePrefix, type ImportLabels } from "./map";

// Why a row was refused, in the user's words, and errores.csv: the refused rows with their reasons next to their
// original cells, so the user fixes them and imports the file again (design §9).

interface Issue {
  path?: PropertyKey[];
  code?: string;
  message?: string;
  expected?: string;
  values?: unknown[];
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  /** False for an exclusive bound (`positive()`: more than 0). */
  inclusive?: boolean;
}

/** How a refusal names the lines sheet as a whole. */
const LINES_LABEL = "Líneas";

const DENIED: Partial<Record<ProcessError["code"], string>> = {
  forbidden: "No tienes permiso para crear este registro",
  not_entitled: "Tu empresa no tiene habilitada esta función",
  step_up_required: "Crear este registro exige verificar tu segundo paso",
  not_found: "Un dato relacionado no existe",
};

/** One Zod issue, named by its column's label. */
function issueText(issue: Issue, columns: ImportColumn[], labels: ImportLabels, input: Record<string, unknown>): string {
  const key = issue.path?.[0];
  const column = columns.find((c) => c.key === key);
  const name = column ? columnLabel(column, labels) : key === undefined ? "" : String(key);
  const prefix = name ? `${name}: ` : "";
  const value = typeof key === "string" ? input[key] : undefined;
  switch (issue.code) {
    case "invalid_type":
      if (value === undefined && (issue.path?.length ?? 0) <= 1) return `${prefix}obligatorio`;
      return `${prefix}${issue.expected === "number" ? "debe ser un número" : issue.expected === "boolean" ? "debe ser sí o no" : "valor no válido"}`;
    case "invalid_value":
      return `${prefix}valor no permitido (${(issue.values ?? column?.options ?? []).map(String).join(", ")})`;
    case "too_small":
      return issue.origin === "string" && Number(issue.minimum) <= 1
        ? `${prefix}obligatorio`
        : `${prefix}${issue.origin === "array" ? `al menos ${issue.minimum} valor(es)` : issue.origin === "string" ? `mínimo ${issue.minimum} caracteres` : issue.inclusive === false ? `debe ser mayor que ${issue.minimum}` : `debe ser al menos ${issue.minimum}`}`;
    case "too_big":
      return `${prefix}${issue.origin === "string" ? `máximo ${issue.maximum} caracteres` : issue.inclusive === false ? `debe ser menor que ${issue.maximum}` : `debe ser como máximo ${issue.maximum}`}`;
    case "invalid_format":
      return `${prefix}formato no válido`;
    default:
      return `${prefix}${issue.message ?? "valor no válido"}`;
  }
}

/**
 * The reasons a create process refused a row: each Zod issue named by its column's label, the process's own
 * messages (the country pack's) as they are, a denial in words; any other failure as one generic reason.
 */
export function describeFailure(
  error: unknown,
  columns: ImportColumn[],
  labels: ImportLabels = {},
  input: Record<string, unknown> = {},
  lines?: { layout: ImportLines; rowNos: readonly number[] },
): string[] {
  if (!(error instanceof ProcessError)) return ["No se pudo crear el registro"];
  if (error.code === "invalid_input" && Array.isArray(error.details) && error.details.length > 0) {
    return error.details.map((detail: unknown) => {
      if (typeof detail === "string") return detail;
      const issue = (detail ?? {}) as Issue;
      // A documento's line (D14): `lines.<n>.<key>` is named by its Líneas row and the line column's label.
      const [key, index, ...rest] = issue.path ?? [];
      // An issue on the lines array itself (none, too many) is the Líneas sheet's.
      if (lines && key === lines.layout.key && typeof index !== "number") return `${LINES_LABEL}: ${issueText({ ...issue, path: [] }, [], labels, {})}`;
      if (lines && key === lines.layout.key && typeof index === "number") {
        const line = Array.isArray(input[lines.layout.key]) ? ((input[lines.layout.key] as unknown[])[index] as Record<string, unknown> | undefined) : undefined;
        const rowNo = lines.rowNos[index];
        const text = issueText({ ...issue, path: rest }, lines.layout.columns, lineLabels(labels), line ?? {});
        return rowNo === undefined ? text : `${linePrefix(rowNo)}${text}`;
      }
      return issueText(issue, columns, labels, input);
    });
  }
  // A refusal that explains itself (the handler's message for the user) is kept.
  const own = Array.isArray(error.details) ? error.details.filter((d): d is string => typeof d === "string") : [];
  if (own.length > 0) return own;
  return [DENIED[error.code] ?? "No se pudo crear el registro"];
}

export interface FailedRow {
  rowNo: number;
  errors: string[];
  /** The row's original cells by header. */
  raw: Record<string, string>;
  /** A documento's row (D14): its lines' Líneas rows and original cells, written after it. */
  lines?: { rowNo: number; raw: Record<string, string> }[];
}

/** A documento's errores.csv (D14): the sheets' names, the Líneas headers and the lines refused on their own. */
export interface DocumentErrors {
  /** The header sheet's name (`Datos`). */
  sheet: string;
  /** The lines sheet's name (`Líneas`). */
  lineSheet: string;
  lineHeaders: string[];
  lineFailures: { rowNo: number; errors: string[]; raw: Record<string, string> }[];
}

/** A value a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, or a tab / carriage return first) is kept as text. */
const inert = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const csvField = (raw: string) => {
  const value = inert(raw);
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};

/**
 * errores.csv: UTF-8 with BOM, ";", CRLF; `fila;error;<the file's headers>` then one line per refused row. Every
 * cell that starts like a formula is prefixed with `'` (CSV injection: the file is opened in Excel).
 *
 * A documento's (`documents`): the columns are `fila;error;<Datos headers>;<Líneas headers>`; `fila` names the row with its sheet
 * (`Datos 3`, `Líneas 7`). Each refused document's row carries its header cells and is followed by one row per line with the line's
 * cells, so the user corrects both; the lines refused on their own come last, with their reason.
 */
export function errorsCsv(headers: string[], failed: FailedRow[], documents?: DocumentErrors): Uint8Array {
  const lineHeaders = documents?.lineHeaders ?? [];
  const blankHeader = headers.map(() => "");
  const blankLines = lineHeaders.map(() => "");
  const lines = [["fila", "error", ...headers, ...lineHeaders].map(csvField).join(";")];
  const push = (cells: string[]) => lines.push(cells.map(csvField).join(";"));
  for (const row of failed) {
    push([documents ? `${documents.sheet} ${row.rowNo}` : String(row.rowNo), row.errors.join(" · "), ...headers.map((h) => row.raw[h] ?? ""), ...blankLines]);
    if (!documents) continue;
    for (const line of row.lines ?? []) push([`${documents.lineSheet} ${line.rowNo}`, "", ...blankHeader, ...lineHeaders.map((h) => line.raw[h] ?? "")]);
  }
  for (const line of documents?.lineFailures ?? []) {
    push([`${documents!.lineSheet} ${line.rowNo}`, line.errors.join(" · "), ...blankHeader, ...lineHeaders.map((h) => line.raw[h] ?? "")]);
  }
  return new TextEncoder().encode(`\uFEFF${lines.join("\r\n")}\r\n`);
}
