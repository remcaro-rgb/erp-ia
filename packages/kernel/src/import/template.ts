import ExcelJS from "exceljs";
import type { Registry } from "../registry";
import { ProcessError } from "../process/errors";
import { importColumns, importLines, type ImportColumn } from "./columns";
import { columnLabel, lineLabels, type ImportLabels } from "./map";
import { LINES_SHEET } from "./parse";
import type { ImportFormat } from "./format";

// The downloadable template of an entity (design §5.11, §9): one column per writable field of its create process,
// in order, headed by the column's label. The XLSX freezes the header, marks the required columns and offers the
// allowed values of list and yes/no columns as dropdowns; the CSV is the header line alone (";", UTF-8 with BOM so
// Excel reads the accents).

/** Why a documento is not imported from (or templated as) a CSV: its header and lines are two sheets (D14). */
export const DOCUMENT_XLSX_ONLY = "Los documentos se importan desde Excel (.xlsx): la hoja Datos con los encabezados y la hoja Líneas con sus líneas, unidas por la columna ref";

export interface ImportTemplate {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Rows of the data sheet that carry the dropdowns. */
const VALIDATED_ROWS = 5_000;
const BOOLEAN_OPTIONS = ["sí", "no"];
const REQUIRED_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };

const columnLetter = (index: number): string => {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const dropdownOf = (column: ImportColumn): string[] | null =>
  column.type === "list" && column.options?.length ? column.options : column.type === "boolean" ? BOOLEAN_OPTIONS : null;

/** What the header cell's note says: the column key, and the allowed values of a list. */
const noteOf = (column: ImportColumn) => [column.key, column.options?.length ? column.options.join(" | ") : null].filter(Boolean).join("\n");

/** One data sheet, labelled, frozen, the required columns marked; returns it for its dropdowns. */
function dataSheet(book: ExcelJS.Workbook, name: string, columns: ImportColumn[], labels: ImportLabels): ExcelJS.Worksheet {
  const sheet = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: columnLabel(c, labels), key: c.key, width: Math.max(14, columnLabel(c, labels).length + 4) }));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.fill = column.required ? REQUIRED_FILL : HEADER_FILL;
    cell.note = noteOf(column);
  });
  return sheet;
}

/** The workbook: the `Datos` sheet, for a documento the `Líneas` sheet (D14), then the hidden lists of the dropdowns. */
async function xlsxTemplate(columns: ImportColumn[], labels: ImportLabels, lineColumns: ImportColumn[] | null): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const parts = [{ columns, sheet: dataSheet(book, "Datos", columns, labels) }];
  if (lineColumns) parts.push({ columns: lineColumns, sheet: dataSheet(book, LINES_SHEET, lineColumns, lineLabels(labels)) });
  // The allowed values live in a hidden sheet after the data sheets (the importer reads the first): a list formula over cells has
  // no length limit.
  const lists = book.addWorksheet("Listas", { state: "veryHidden" });
  let listColumn = 0;
  for (const { columns: list, sheet } of parts) {
    list.forEach((column, index) => {
      const options = dropdownOf(column);
      if (!options) return;
      const letter = columnLetter(listColumn++);
      options.forEach((option, i) => (lists.getCell(`${letter}${i + 1}`).value = option));
      const formula = `Listas!$${letter}$1:$${letter}$${options.length}`;
      const target = columnLetter(index);
      for (let row = 2; row <= VALIDATED_ROWS + 1; row++) {
        sheet.getCell(`${target}${row}`).dataValidation = { type: "list", allowBlank: true, formulae: [formula] };
      }
    });
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}

function csvTemplate(columns: ImportColumn[], labels: ImportLabels): Uint8Array {
  const header = columns.map((c) => {
    const label = columnLabel(c, labels);
    return /[";\r\n]/.test(label) ? `"${label.replace(/"/g, '""')}"` : label;
  });
  return new TextEncoder().encode(`\uFEFF${header.join(";")}\r\n`);
}

/** The import template of `entityId` in `format`, headed by `options.labels` (column key → label) or the keys. */
export async function buildTemplate(
  registry: Registry,
  entityId: string,
  format: ImportFormat,
  options: { labels?: ImportLabels } = {},
): Promise<ImportTemplate> {
  const columns = importColumns(registry, entityId);
  const lines = importLines(registry, entityId);
  const labels = options.labels ?? {};
  const fileName = `plantilla_${entityId}.${format}`;
  // A documento's header and lines are two sheets (D14): a CSV holds one.
  if (lines && format === "csv") throw new ProcessError("invalid_input", `${entityId} imports header and lines: no CSV template`, { details: [DOCUMENT_XLSX_ONLY] });
  return format === "xlsx"
    ? { fileName, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: await xlsxTemplate(columns, labels, lines?.columns ?? null) }
    : { fileName, mimeType: "text/csv; charset=utf-8", bytes: csvTemplate(columns, labels) };
}
