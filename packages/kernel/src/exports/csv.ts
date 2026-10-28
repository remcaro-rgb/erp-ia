import { cellOf, cellText, defuse, isSpanish, MASK } from "./format";
import type { ExportColumn, RowSource, WriterOptions } from "./types";

// CSV as Excel opens it (design §9): UTF-8 with a BOM, `;` between columns for es-419 (the decimal mark is a comma
// there) and `,` otherwise, CRLF, text always in quotes with the quote doubled. Dates are ISO, money and numbers are
// bare decimals, a masked column prints `••••••`, and a text cell that starts like a formula is defused.

const BOM = "﻿";
const ROWS_PER_CHUNK = 200;

const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;

function csvCell(column: ExportColumn, value: unknown, options: WriterOptions): string {
  const cell = cellOf(column, value, options);
  if (cell.type === "empty") return "";
  if (cell.type === "mask") return quoted(MASK);
  if (cell.type === "text") return quoted(defuse(cell.value));
  return cellText(column, value, options);
}

const iterate = (rows: RowSource): AsyncIterator<Record<string, unknown>> =>
  Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : (async function* () { yield* rows as Iterable<Record<string, unknown>>; })();

/**
 * The file as a stream of bytes: the header, then the rows as they are read from `rows` (a page at a time, never the
 * whole set in memory). Cancelling the stream stops reading.
 */
export function writeCsv(columns: readonly ExportColumn[], rows: RowSource, options: WriterOptions = {}): ReadableStream<Uint8Array> {
  const separator = isSpanish(options.locale) ? ";" : ",";
  const encoder = new TextEncoder();
  const line = (cells: string[]) => `${cells.join(separator)}\r\n`;
  const iterator = iterate(rows);
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(BOM + line(columns.map((c) => quoted(defuse(c.label))))));
        return;
      }
      let chunk = "";
      for (let i = 0; i < ROWS_PER_CHUNK; i++) {
        const next = await iterator.next();
        if (next.done) {
          if (chunk) controller.enqueue(encoder.encode(chunk));
          controller.close();
          return;
        }
        chunk += line(columns.map((c) => csvCell(c, next.value[c.field], options)));
      }
      controller.enqueue(encoder.encode(chunk));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
