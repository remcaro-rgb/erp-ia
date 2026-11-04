import { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { cellOf } from "./format";
import type { ExportColumn, RowSource, WriterOptions } from "./types";

// Excel keeps types (design §9): dates are date cells, money and numbers are numeric cells (money formatted
// `#,##0.00`), the header is bold, frozen and filterable. A masked column holds the text `••••••` on every row.
// Rows are written as they are read and committed, so a large set never sits in memory as a worksheet.

export const MONEY_FORMAT = "#,##0.00";
const DATE_FORMAT = "yyyy-mm-dd";
const DATETIME_FORMAT = "yyyy-mm-dd hh:mm";
const FORBIDDEN_IN_SHEET_NAME = /[\\/*?:[\]]/g;

/** A worksheet name Excel accepts: no `\ / * ? : [ ]`, at most 31 characters, never empty. */
export function sheetName(title: string | undefined): string {
  const name = (title ?? "").replace(FORBIDDEN_IN_SHEET_NAME, "").replace(/\s+/g, " ").trim().slice(0, 31).trim();
  return name === "" ? "Datos" : name;
}

const widthOf = (column: ExportColumn): number => {
  const minimum = column.type === "money" ? 16 : column.type === "datetime" ? 18 : column.type === "date" || column.type === "number" || column.type === "boolean" ? 12 : 22;
  return Math.min(60, Math.max(minimum, column.label.length + 4));
};

const rowsOf = (rows: RowSource): AsyncIterable<Record<string, unknown>> =>
  Symbol.asyncIterator in rows ? rows : (async function* () { yield* rows as Iterable<Record<string, unknown>>; })();

/** The workbook as a Buffer: one sheet named after `title`. */
export async function writeXlsx(columns: readonly ExportColumn[], rows: RowSource, options: WriterOptions & { title?: string } = {}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true, useSharedStrings: false });
  book.creator = "Goliatt";
  book.created = new Date();
  const sheet = book.addWorksheet(sheetName(options.title), { views: [{ state: "frozen", xSplit: 0, ySplit: 1 }], properties: { outlineProperties: { summaryBelow: true, summaryRight: true } } });
  sheet.columns = columns.map((c) => ({ key: c.field, width: widthOf(c) }));

  const header = sheet.addRow(columns.map((c) => c.label));
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };
  header.commit();

  let count = 0;
  for await (const source of rowsOf(rows)) {
    const row = sheet.addRow([]);
    columns.forEach((column, index) => {
      const cell = cellOf(column, source[column.field], options);
      const target = row.getCell(index + 1);
      switch (cell.type) {
        case "empty":
          break;
        case "mask":
          target.value = "••••••";
          break;
        case "text":
          target.value = cell.value;
          break;
        case "number":
          target.value = cell.value;
          if (cell.money) target.numFmt = MONEY_FORMAT;
          break;
        case "date":
          target.value = cell.value;
          target.numFmt = DATE_FORMAT;
          break;
        case "datetime":
          target.value = cell.wall;
          target.numFmt = DATETIME_FORMAT;
          break;
      }
    });
    // A grouped export (grouped.ts): the lines nest under their group's summary, which is bold.
    const level = source.__level;
    if (typeof level === "number") row.outlineLevel = level;
    if (source.__kind) row.font = { bold: true };
    row.commit();
    count += 1;
  }
  if (columns.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: count + 1, column: columns.length } };
  sheet.commit();
  await book.commit();
  return Buffer.concat(chunks);
}
