import { LINES_LABEL_PREFIX, REF_KEY, type ImportColumn, type ImportLines } from "./columns";
import type { Cell, ImportBook, ParsedSheet } from "./parse";

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
  /** A documento's record (D14): the Líneas row of each of its lines, in the order of `input[lines.key]`. */
  lineRows?: number[];
  /** A documento's record: each of its lines' Líneas row and original cells, for errores.csv. */
  lines?: { rowNo: number; raw: Record<string, string> }[];
}

/** A line of a documento's Líneas sheet refused on its own (its `ref` names no header row): a line error, not a refused document. */
export interface LineFailure {
  rowNo: number;
  errors: string[];
  raw: Record<string, string>;
}

export interface MappedSheet {
  headers: string[];
  /** Column key of each header, or null for a header that matches no column. */
  mapping: (string | null)[];
  unknownHeaders: string[];
  /** Keys of the required columns no header matches. */
  missingColumns: string[];
  records: ImportRecord[];
  /** A documento's file (D14): the Líneas sheet's headers, and its lines refused on their own. */
  lineHeaders?: string[];
  lineFailures?: LineFailure[];
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** The label a column shows to the user: its translated label, or its key. */
export const columnLabel = (column: ImportColumn, labels: ImportLabels = {}) => labels[column.key] ?? column.key;

/**
 * A cell as text. A `'` that errores.csv put before `=`, `+`, `-` or `@` (to keep Excel from running it) is dropped,
 * so a corrected errores.csv imports as the original (`+57…` phones, negative numbers).
 */
const asText = (cell: Cell) => {
  const text = cell === null ? "" : typeof cell === "string" ? cell : String(cell);
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
};

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

/**
 * The in-file duplicates among `rows` (the rows that passed validation, in file order): a row that repeats an
 * earlier one of them on the entity's `importKey` fields (case and surrounding spaces ignored) is refused, naming the
 * row it repeats. Only valid rows count: a corrected copy of a refused row is not a duplicate. Rows missing a key
 * value are left to the process. Returns the refusal of each duplicate by its index.
 */
export function inFileDuplicates(
  columns: ImportColumn[],
  rows: readonly { index: number; record: ImportRecord }[],
  importKey: readonly string[] | undefined,
  labels: ImportLabels = {},
): Map<number, string> {
  const duplicates = new Map<number, string>();
  if (!importKey?.length) return duplicates;
  const keyColumns = importKey.map((field) => columns.find((c) => c.field === field));
  if (keyColumns.some((c) => c === undefined)) return duplicates;
  const names = keyColumns.map((c) => columnLabel(c!, labels)).join(", ");
  const first = new Map<string, number>();
  for (const { index, record } of rows) {
    const parts = keyColumns.map((c) => record.input[c!.key]);
    if (parts.some((p) => p === undefined || p === null || String(p).trim() === "")) continue;
    const key = JSON.stringify(parts.map((p) => String(p).trim().toLowerCase()));
    const seen = first.get(key);
    if (seen === undefined) first.set(key, record.rowNo);
    else duplicates.set(index, `${names}: repetido en el archivo (igual a la fila ${seen})`);
  }
  return duplicates;
}

/** The labels of the lines sheet's columns: the entries of `labels` under `lines.`, without the prefix (and `ref`). */
export function lineLabels(labels: ImportLabels = {}): ImportLabels {
  const out: ImportLabels = labels[REF_KEY] ? { [REF_KEY]: labels[REF_KEY]! } : {};
  for (const [key, label] of Object.entries(labels)) if (key.startsWith(LINES_LABEL_PREFIX)) out[key.slice(LINES_LABEL_PREFIX.length)] = label;
  return out;
}

/** "Líneas, fila 7: " — what a line's refusal starts with: the row the user fixes in the Líneas sheet. */
export const linePrefix = (rowNo: number) => `Líneas, fila ${rowNo}: `;

const refOf = (record: ImportRecord) => {
  const ref = record.input[REF_KEY];
  return ref === undefined || ref === null || String(ref).trim() === "" ? null : String(ref).trim().toLowerCase();
};

/** What a document without lines is refused with when no catalogue says it (`grid.import.document_without_lines`). */
const NO_LINES = "El documento no tiene líneas";

/**
 * A documento's file as records (entity types spec §2.5, D14): one record per header row, whose input carries the lines of the Líneas
 * sheet with the same `ref` (case and surrounding spaces ignored) under `lines.key`, in sheet order. The `ref` itself is not an input of
 * the create process. The record's errors:
 * - a header row without `ref`;
 * - header rows sharing a `ref`: every one of them is refused, the first included, with none of their lines (the file does not say
 *   which lines belong to which);
 * - a header row with no lines ("El documento no tiene líneas", from the catalogue through `t` when given);
 * - a line cell that cannot be read, named by its Líneas row.
 * A line whose `ref` names no header row is a line failure of its own (`lineFailures`), never silently dropped and never counted as a
 * refused document. The headers, mapping and missing columns are the header sheet's (a required line column the Líneas sheet lacks is
 * missing too, as `lines.<key>`).
 */
export function mapDocuments(
  columns: ImportColumn[],
  lines: ImportLines,
  book: ImportBook,
  labels: ImportLabels = {},
  t?: (key: string) => string | undefined,
): MappedSheet {
  const header = mapSheet(columns, book.header, labels);
  const lineSheet = mapSheet(lines.columns, book.lines ?? { headers: [], rows: [] }, lineLabels(labels));
  const refLabel = columnLabel(columns.find((c) => c.key === REF_KEY)!, labels);
  const byRef = new Map<string, ImportRecord[]>();
  for (const record of header.records) {
    const ref = refOf(record);
    delete record.input[REF_KEY];
    record.input[lines.key] = [];
    record.lineRows = [];
    record.lines = [];
    if (ref === null) record.errors.push(`${refLabel}: obligatorio`);
    else byRef.set(ref, [...(byRef.get(ref) ?? []), record]);
  }
  for (const group of byRef.values()) {
    if (group.length < 2) continue;
    const rows = group.map((r) => r.rowNo).join(", ");
    for (const record of group) record.errors.push(`${refLabel}: repetido en el archivo (filas ${rows})`);
  }
  const lineFailures: LineFailure[] = [];
  for (const line of lineSheet.records) {
    const ref = refOf(line);
    const owners = ref === null ? undefined : byRef.get(ref);
    if (!owners) {
      const shown = line.input[REF_KEY] === undefined ? "" : String(line.input[REF_KEY]).trim();
      lineFailures.push({ rowNo: line.rowNo, raw: line.raw, errors: [shown === "" ? `${refLabel}: obligatorio` : `${refLabel} «${shown}» no corresponde a ningún encabezado`] });
      continue;
    }
    // A repeated ref: its lines belong to no document (each of those rows is already refused).
    if (owners.length > 1) continue;
    const owner = owners[0]!;
    delete line.input[REF_KEY];
    owner.errors.push(...line.errors.map((error) => `${linePrefix(line.rowNo)}${error}`));
    (owner.input[lines.key] as Record<string, unknown>[]).push(line.input);
    owner.lineRows!.push(line.rowNo);
    owner.lines!.push({ rowNo: line.rowNo, raw: line.raw });
  }
  for (const record of header.records) {
    if (record.errors.length === 0 && (record.input[lines.key] as unknown[]).length === 0) record.errors.push(t?.("grid.import.document_without_lines") ?? NO_LINES);
  }
  return {
    ...header,
    missingColumns: [...header.missingColumns, ...lineSheet.missingColumns.map((key) => `${LINES_LABEL_PREFIX}${key}`)],
    records: header.records,
    lineHeaders: lineSheet.headers,
    lineFailures,
  };
}
