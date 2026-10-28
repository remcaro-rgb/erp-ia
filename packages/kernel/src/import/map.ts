import type { ImportColumn } from "./columns";
import type { Cell, ParsedSheet } from "./parse";

// From a parsed sheet to create-process inputs (design §5.11 "map"): each header is matched to a column by its
// label, its key or its field name (case, accents and punctuation ignored), and each cell is coerced to its
// column's type. A cell that cannot be read is a row error; the process validates everything else.

/** Column key → the header text the template shows for it (the Spanish label). */
export type ImportLabels = Record<string, string>;

export interface ImportRecord {
  rowNo: number;
  /** The row's cells by header, as text, for errores.csv. */
  raw: Record<string, string>;
  /** The create process input built from the row (empty cells left out). */
  input: Record<string, unknown>;
  /** Cells that could not be read as their column's type. */
  errors: string[];
}

export interface MappedSheet {
  headers: string[];
  /** Column key of each header, or null for a header that matches no column. */
  mapping: (string | null)[];
  unknownHeaders: string[];
  /** Keys of the required columns no header matches. */
  missingColumns: string[];
  records: ImportRecord[];
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** The label a column shows to the user: its translated label, or its key. */
export const columnLabel = (column: ImportColumn, labels: ImportLabels = {}) => labels[column.key] ?? column.key;

const asText = (cell: Cell) => (cell === null ? "" : typeof cell === "string" ? cell : String(cell));

const TRUE = new Set(["si", "s", "true", "verdadero", "1", "x", "yes", "y"]);
const FALSE = new Set(["no", "n", "false", "falso", "0"]);

/** A number written as `1.234.567,89` (es-CO), `1234567.89` or `31000`; null when it is not one. */
export function parseNumber(text: string): number | null {
  let t = text.trim().replace(/\s|\$/g, "");
  if (t === "" || !/^[-+]?[\d.,]+$/.test(t)) return null;
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both: the last one is the decimal separator.
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    t = /^[-+]?\d{1,3}(,\d{3}){2,}$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if (lastDot >= 0 && /^[-+]?\d{1,3}(\.\d{3})+$/.test(t)) {
    // 1.234 or 1.234.567: thousands separators in es-CO.
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

type Coerced = { value?: unknown; error?: string };

function coerce(column: ImportColumn, cell: Cell, label: string): Coerced {
  const text = asText(cell).trim();
  switch (column.type) {
    case "number": {
      if (typeof cell === "number") return { value: cell };
      if (text === "") return {};
      const n = parseNumber(text);
      return n === null ? { error: `${label}: «${text}» no es un número` } : { value: n };
    }
    case "boolean": {
      if (typeof cell === "boolean") return { value: cell };
      if (text === "") return {};
      const key = normalize(text);
      if (TRUE.has(key)) return { value: true };
      if (FALSE.has(key)) return { value: false };
      return { error: `${label}: «${text}» no es sí o no` };
    }
    case "list": {
      if (text === "") return {};
      // The allowed value in its own spelling; anything else goes to the process, which names the column.
      return { value: column.options?.find((o) => o.toLowerCase() === text.toLowerCase()) ?? text };
    }
    case "multi": {
      // An empty list is a value: the process decides whether the column may be empty.
      const parts = text
        .split(/[|,;]/)
        .map((p) => p.trim())
        .filter((p) => p !== "");
      return { value: parts.map((p) => column.options?.find((o) => o.toLowerCase() === p.toLowerCase()) ?? p) };
    }
    default:
      return text === "" ? {} : { value: text };
  }
}

/** Matches the headers to `columns` and builds one record per data row. */
export function mapSheet(columns: ImportColumn[], sheet: ParsedSheet, labels: ImportLabels = {}): MappedSheet {
  const byName = new Map<string, string>();
  for (const column of columns) {
    // The label wins over another column's key or field name.
    for (const name of [column.field, column.key]) byName.set(normalize(name), column.key);
  }
  for (const column of columns) if (labels[column.key]) byName.set(normalize(labels[column.key]!), column.key);

  const taken = new Set<string>();
  const mapping = sheet.headers.map((header) => {
    const key = header === "" ? undefined : byName.get(normalize(header));
    // A column named twice is read from its first header only.
    if (key === undefined || taken.has(key)) return null;
    taken.add(key);
    return key;
  });
  const unknownHeaders = sheet.headers.filter((h, i) => h !== "" && mapping[i] === null);
  const missingColumns = columns.filter((c) => c.required && !taken.has(c.key)).map((c) => c.key);
  const columnByKey = new Map(columns.map((c) => [c.key, c]));

  const records = sheet.rows.map(({ rowNo, cells }) => {
    const raw: Record<string, string> = {};
    const input: Record<string, unknown> = {};
    const errors: string[] = [];
    sheet.headers.forEach((header, i) => {
      const cell = cells[i] ?? null;
      if (header !== "") raw[header] = asText(cell);
      const key = mapping[i];
      if (!key) return;
      const column = columnByKey.get(key)!;
      const { value, error } = coerce(column, cell, columnLabel(column, labels));
      if (error) errors.push(error);
      else if (value !== undefined) input[key] = value;
    });
    return { rowNo, raw, input, errors };
  });
  return { headers: sheet.headers, mapping, unknownHeaders, missingColumns, records };
}
