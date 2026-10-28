import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { importFormatOf } from "./format";

export { importFormatOf, type ImportFormat } from "./format";

// Reading an import file (design §5.11): CSV separated by ";" or "," (UTF-8, or the Windows-1252 Excel writes as
// "CSV" on Windows) or the first sheet of an XLSX workbook. The header is the first row; data rows keep the number
// the spreadsheet shows (header = 1) so errores.csv points at the same line; blank rows are skipped.

/** A cell as read: text from CSV, typed values from XLSX. */
export type Cell = string | number | boolean | null;

export interface ParsedSheet {
  headers: string[];
  rows: { rowNo: number; cells: Cell[] }[];
}

/** Rows one file may carry (prototype: "hasta 50.000 filas por archivo"). */
export const MAX_IMPORT_ROWS = 50_000;
/** Columns one file may carry. */
export const MAX_IMPORT_COLUMNS = 256;
/** What an XLSX may unpack to, all its parts together, before it is opened (a 25 MB upload can hide far more). */
export const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/** Parts an XLSX may have. */
const MAX_XLSX_ENTRIES = 1_000;

const FILE_ERROR = Symbol.for("erp.kernel.ImportFileError");

/** A file that cannot be imported as a whole; `message` is for the user (Spanish). Recognised across module copies, like ProcessError. */
export class ImportFileError extends Error {
  readonly [FILE_ERROR] = true;

  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { [FILE_ERROR]?: unknown })[FILE_ERROR] === true;
  }
}


/** UTF-8 text without its BOM; bytes that are not valid UTF-8 are read as Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Counts `char` outside double quotes in `line`. */
function countOutsideQuotes(line: string, char: string): number {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === char && !quoted) n++;
  }
  return n;
}

/**
 * RFC 4180 CSV: the separator is ";" unless the header line has more "," (Excel in Spanish writes ";"); quoted
 * fields may hold separators, doubled quotes and line breaks; CRLF or LF. Returns every line, blank ones included.
 */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const separator = countOutsideQuotes(firstLine, ",") > countOutsideQuotes(firstLine, ";") ? "," : ";";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === separator) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const tooWide = () => new ImportFileError(`El archivo tiene más de ${MAX_IMPORT_COLUMNS} columnas`);
const tooLong = () => new ImportFileError("El archivo tiene más de 50.000 filas");

const blank = (cells: Cell[]) => cells.every((c) => c === null || (typeof c === "string" && c.trim() === ""));

function sheetOf(lines: Cell[][]): ParsedSheet {
  if (lines.some((cells) => cells.length > MAX_IMPORT_COLUMNS && cells.slice(MAX_IMPORT_COLUMNS).some((c) => !blank([c])))) throw tooWide();
  const [header = [], ...data] = lines;
  const headers = header.map((h) => (h === null ? "" : String(h).trim()));
  // Trailing unnamed header cells are not columns.
  while (headers.length > 0 && headers[headers.length - 1] === "") headers.pop();
  const rows = data.map((cells, i) => ({ rowNo: i + 2, cells })).filter((r) => !blank(r.cells));
  if (rows.length > MAX_IMPORT_ROWS) throw tooLong();
  return { headers, rows };
}

/** The value a spreadsheet cell shows, typed: numbers and booleans stay typed, dates become `YYYY-MM-DD`, text is text. */
function xlsxCell(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("result" in value) return xlsxCell((value.result ?? null) as ExcelJS.CellValue);
    if ("text" in value) return String(value.text);
    if ("error" in value) return null;
  }
  return String(value);
}

/**
 * Unpacks every part of the workbook once, with a hard bound, before ExcelJS sees it: the sizes a zip declares are
 * the uploader's to forge, so each deflated part is inflated with `maxOutputLength` set to what is left of
 * `MAX_XLSX_UNCOMPRESSED_BYTES` (the inflater stops there instead of allocating the real size) and the running total
 * of the real sizes is held to the same cap. More than `MAX_XLSX_ENTRIES` parts, ZIP64, an unknown compression method
 * or anything that is not a zip is refused. Nothing is kept: the bytes inflated here are dropped part by part.
 */
export function checkXlsxSize(bytes: Uint8Array): void {
  const notWorkbook = () => new ImportFileError("El archivo no es un libro de Excel (.xlsx) válido");
  const tooBig = () => new ImportFileError("El libro de Excel es demasiado grande al descomprimirlo");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notWorkbook();
  const entries = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || directoryOffset === 0xffffffff || entries > MAX_XLSX_ENTRIES) throw tooBig();
  let at = directoryOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) throw notWorkbook();
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const declared = view.getUint32(at + 24, true);
    const local = view.getUint32(at + 42, true);
    if (compressed === 0xffffffff || declared === 0xffffffff || local === 0xffffffff) throw tooBig();
    if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== 0x04034b50) throw notWorkbook();
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > bytes.byteLength) throw notWorkbook();
    // The declared size is the uploader's word: an over-large one is refused at once, a small one proves nothing.
    if (declared > MAX_XLSX_UNCOMPRESSED_BYTES) throw tooBig();
    const remaining = MAX_XLSX_UNCOMPRESSED_BYTES - total;
    let size: number;
    if (method === 0) {
      size = compressed;
    } else if (method === 8) {
      try {
        size = inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, remaining) }).byteLength;
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
        throw notWorkbook();
      }
    } else {
      throw notWorkbook();
    }
    total += size;
    if (total > MAX_XLSX_UNCOMPRESSED_BYTES) throw tooBig();
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
}

/**
 * The first sheet of an XLSX, after `checkXlsxSize` has bounded what the workbook unpacks to (64 MB of XML at most).
 * The sheet's extent (rows, columns) is checked before a cell is copied. It is loaded whole rather than streamed:
 * ExcelJS 4.4's streaming WorkbookReader fails on workbooks whose sheets come before `xl/workbook.xml` in the zip
 * (`this.model` is undefined), spills sheets that precede the shared strings to temp files on disk, and numbers
 * sheets by zip order instead of workbook order.
 */
async function readXlsx(bytes: Uint8Array): Promise<Cell[][]> {
  checkXlsxSize(bytes);
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new ImportFileError("El archivo no es un libro de Excel (.xlsx) válido");
  }
  const sheet = book.worksheets[0];
  if (!sheet) return [];
  if (sheet.columnCount > MAX_IMPORT_COLUMNS) throw tooWide();
  if (sheet.rowCount > MAX_IMPORT_ROWS + 1) throw tooLong();
  const lines: Cell[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = row.values as ExcelJS.CellValue[];
    // `values` is 1-based: index 0 is empty.
    lines[rowNumber - 1] = values.slice(1).map(xlsxCell);
  });
  for (let i = 0; i < lines.length; i++) lines[i] ??= [];
  return lines;
}

/** Reads an import file by its name's extension (`.csv`, `.txt`, `.xlsx`). Throws `ImportFileError`. */
export async function parseImportFile(bytes: Uint8Array, fileName: string): Promise<ParsedSheet> {
  const format = importFormatOf(fileName);
  if (format === null) throw new ImportFileError("El archivo debe ser .xlsx o .csv");
  const lines = format === "csv" ? parseCsv(decodeText(bytes)) : await readXlsx(bytes);
  if (lines.length === 0) throw new ImportFileError("El archivo está vacío");
  return sheetOf(lines);
}
