import { ProcessError } from "../process/errors";
import type { ImportColumn } from "./columns";
import { columnLabel, type ImportLabels } from "./map";

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
}

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
        : `${prefix}${issue.origin === "array" ? `al menos ${issue.minimum} valor(es)` : issue.origin === "string" ? `mínimo ${issue.minimum} caracteres` : `debe ser al menos ${issue.minimum}`}`;
    case "too_big":
      return `${prefix}${issue.origin === "string" ? `máximo ${issue.maximum} caracteres` : `debe ser como máximo ${issue.maximum}`}`;
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
export function describeFailure(error: unknown, columns: ImportColumn[], labels: ImportLabels = {}, input: Record<string, unknown> = {}): string[] {
  if (!(error instanceof ProcessError)) return ["No se pudo crear el registro"];
  if (error.code === "invalid_input" && Array.isArray(error.details) && error.details.length > 0) {
    return error.details.map((detail: unknown) =>
      typeof detail === "string" ? detail : issueText((detail ?? {}) as Issue, columns, labels, input),
    );
  }
  return [DENIED[error.code] ?? "No se pudo crear el registro"];
}

export interface FailedRow {
  rowNo: number;
  errors: string[];
  /** The row's original cells by header. */
  raw: Record<string, string>;
}

const csvField = (value: string) => (/[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** errores.csv: UTF-8 with BOM, ";", CRLF; `fila;error;<the file's headers>` then one line per refused row. */
export function errorsCsv(headers: string[], failed: FailedRow[]): Uint8Array {
  const lines = [["fila", "error", ...headers].map(csvField).join(";")];
  for (const row of failed) {
    lines.push([String(row.rowNo), row.errors.join(" · "), ...headers.map((h) => row.raw[h] ?? "")].map(csvField).join(";"));
  }
  return new TextEncoder().encode(`\uFEFF${lines.join("\r\n")}\r\n`);
}
