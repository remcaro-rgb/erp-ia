import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement as h } from "react";
import { cellOf, cellText, isSpanish, isoDay, moneyText, wallClock } from "./format";
import type { ExportColumn, RowSource, WriterOptions } from "./types";

// (No JSX syntax on purpose: the Workflow bundlers load this file from the step bundle, which only reads plain
// TypeScript.)
//
// The PDF is the page the user sees (design §9, rule 23): A4 landscape, the header row repeated on every page, page
// numbers, money as `$ 1.234.567,00` right-aligned and a totals row for the money columns. Same columns and same
// masking as the other two formats.

const TEXT = {
  es: { page: (n: number, total: number) => `Página ${n} de ${total}`, total: "Total", rows: (n: number) => `${n} ${n === 1 ? "registro" : "registros"}` },
  en: { page: (n: number, total: number) => `Page ${n} of ${total}`, total: "Total", rows: (n: number) => `${n} ${n === 1 ? "record" : "records"}` },
};

const WEIGHT: Record<ExportColumn["type"], number> = { text: 2, enum: 1.3, json: 2, money: 1.3, number: 0.8, date: 1, datetime: 1.4, boolean: 0.7 };
const NUMERIC = new Set<ExportColumn["type"]>(["money", "number"]);
/** Rows laid out on one page of A4 landscape at this size. */
const ROWS_PER_PAGE = 28;
const INK = "#1f2937";
const MUTED = "#6b7280";

const styles = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 38, paddingHorizontal: 28, fontFamily: "Helvetica", fontSize: 8, color: INK },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 },
  title: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  meta: { fontSize: 8, color: MUTED },
  headRow: { flexDirection: "row", backgroundColor: "#1f3a5f", color: "#ffffff", fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  zebra: { backgroundColor: "#f8fafc" },
  total: { flexDirection: "row", borderTopWidth: 1, borderTopColor: INK, fontFamily: "Helvetica-Bold", marginTop: 1 },
  cell: { paddingVertical: 3, paddingHorizontal: 4 },
  right: { textAlign: "right" },
  footer: { position: "absolute", left: 28, right: 28, bottom: 16, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: MUTED },
});

const rowsOf = (rows: RowSource): AsyncIterable<Record<string, unknown>> =>
  Symbol.asyncIterator in rows ? rows : (async function* () { yield* rows as Iterable<Record<string, unknown>>; })();

interface PdfOptions extends WriterOptions {
  title?: string;
  company?: string;
  /** The company's NIT, printed beside its name (reports). */
  taxId?: string;
  /** The report's parameters as one line under the title (reports). */
  params?: string;
  /** Fields the totals row sums; the money columns when absent (a report names its own). */
  totalFields?: readonly string[];
}

interface TableOptions extends WriterOptions {
  totalFields?: readonly string[];
}

/** What the table prints, cell by cell, as text: the body and the totals row of the money columns (null: none). */
export async function pdfTable(columns: readonly ExportColumn[], rows: RowSource, options: TableOptions = {}): Promise<{ body: string[][]; totals: string[] | null }> {
  const text = isSpanish(options.locale) ? TEXT.es : TEXT.en;
  const body: string[][] = [];
  const sums = columns.map(() => 0);
  for await (const row of rowsOf(rows)) {
    body.push(
      columns.map((column, i) => {
        const cell = cellOf(column, row[column.field], options);
        if (cell.type === "number" && (cell.money || options.totalFields?.includes(column.field))) sums[i] = (sums[i] ?? 0) + cell.value;
        return cellText(column, row[column.field], { ...options, paper: true });
      }),
    );
  }
  const summed = columns.map((column) => !column.masked && (options.totalFields ? options.totalFields.includes(column.field) : column.type === "money"));
  const totals = summed.some(Boolean) && body.length > 0 ? columns.map((_, i) => (summed[i] ? (columns[i]!.type === "money" ? moneyText(sums[i] ?? 0) : String(sums[i] ?? 0)) : i === 0 ? text.total : "")) : null;
  return { body, totals };
}

/** The PDF as a Buffer. The rows are read in full: a page break needs the whole table. */
export async function writePdf(columns: readonly ExportColumn[], rows: RowSource, options: PdfOptions = {}): Promise<Buffer> {
  const text = isSpanish(options.locale) ? TEXT.es : TEXT.en;
  const { body, totals } = await pdfTable(columns, rows, options);
  const owner = [options.company, options.taxId ? `NIT ${options.taxId}` : undefined].filter(Boolean).join(" · ");
  const total = weightTotal(columns);
  const widthOf = (column: ExportColumn) => `${((WEIGHT[column.type] / total) * 100).toFixed(3)}%`;
  const align = (column: ExportColumn) => (NUMERIC.has(column.type) ? styles.right : {});
  const generated = wallClock(new Date(), options.timeZone);
  const stamp = `${isoDay(generated)} ${String(generated.getUTCHours()).padStart(2, "0")}:${String(generated.getUTCMinutes()).padStart(2, "0")}`;

  const cell = (column: ExportColumn, value: string | undefined) => h(Text, { key: column.field, style: [styles.cell, align(column), { width: widthOf(column) }] }, value);
  const tableHead = h(View, { style: styles.headRow, fixed: true }, ...columns.map((column) => cell(column, column.label)));
  const tableRows = body.map((cells, r) =>
    h(View, { key: r, style: r % 2 === 1 ? [styles.row, styles.zebra] : styles.row, wrap: false }, ...columns.map((column, i) => cell(column, cells[i]))),
  );
  const totalsRow = totals ? h(View, { style: styles.total, wrap: false }, ...columns.map((column, i) => cell(column, totals[i]))) : null;
  const heading = () =>
    h(
      View,
      { style: styles.head, fixed: true },
      h(View, null, h(Text, { style: styles.title }, options.title ?? ""), owner ? h(Text, { style: styles.meta }, owner) : null, options.params ? h(Text, { style: styles.meta }, options.params) : null),
      h(Text, { style: styles.meta }, `${text.rows(body.length)} · ${stamp}`),
    );
  const footer = () =>
    h(
      View,
      { style: styles.footer, fixed: true },
      h(Text, null, owner),
      h(Text, { render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => text.page(pageNumber, totalPages) }),
    );
  // The table is laid out a screenful of rows per <Page>: the engine paginates a single page of thousands of rows
  // far slower than linearly. A screenful that does not fit (wrapped text) still flows onto the next page.
  const pages: ReturnType<typeof h>[] = [];
  const chunks = Math.max(1, Math.ceil(tableRows.length / ROWS_PER_PAGE));
  for (let i = 0; i < chunks; i++) {
    const last = i === chunks - 1;
    pages.push(
      h(Page, { key: i, size: "A4", orientation: "landscape", style: styles.page }, heading(), tableHead, ...tableRows.slice(i * ROWS_PER_PAGE, (i + 1) * ROWS_PER_PAGE), last ? totalsRow : null, footer()),
    );
  }
  const document = h(Document, { title: options.title, author: options.company, creator: "ERP-IA", producer: "ERP-IA" }, ...pages);
  return renderToBuffer(document);
}

function weightTotal(columns: readonly ExportColumn[]): number {
  return columns.reduce((sum, column) => sum + WEIGHT[column.type], 0) || 1;
}
