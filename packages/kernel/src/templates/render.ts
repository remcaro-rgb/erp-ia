import { Document, Image, Page, renderToBuffer, Text, View } from "@react-pdf/renderer";
import { PDFDocument } from "pdf-lib";
import { createElement as h, type ReactElement } from "react";
import { NUMERIC, pdfTable, WEIGHT } from "../exports/pdf";
import type { ExportColumn, ExportRow } from "../exports/types";
import { A4 } from "./defaults";
import type { Block, Template } from "./schema";

// A template turned into a PDF (entity types spec 2026-11-02 §6) with the existing @react-pdf/renderer stack. Plain TypeScript, no JSX
// syntax: like exports/pdf.ts this file may be loaded from a Workflow step bundle (the state e-mails of Task 12), which only reads
// plain TypeScript, and the kernel's tsconfig has no JSX.
//
// Layout: every block sits where it says (points from the page's top-left corner). Every page prints every block, so a header or a
// letterhead repeats; a `lines` table flows over as many pages as its rows need, its header row repeated, the totals of its money
// columns after the last row. A background PDF is drawn under the blocks as a vector page (pdf-lib): its first page under the first
// page, its second page (when it has one) under the continuation pages, and the pages take its size. Without a background a record
// prints on A4 portrait and a list on A4 landscape.

/** The rows a `lines` block prints: the record's lines or the list's rows, and the caller's columns of them. */
export interface TableSource {
  columns: readonly ExportColumn[];
  rows: readonly ExportRow[];
}

export interface RenderOptions {
  /** `es-419` (default) or `en`: Sí / No, the decimal mark. */
  locale?: string;
  /**
   * The words of a page number block without its own pattern, `{n}` the page and `{total}` the pages: the caller's catalogue
   * (`common.print.page_number`, packages/i18n, rule 24). Without them only the numbers print (`1 / 3`).
   */
  pageText?: string;
  /** The company's zone, for date-times in the table. */
  timeZone?: string;
  /**
   * The instant the document says it was made (its CreationDate and ModDate). Fixed, the same template and data give the same bytes
   * (Task 12: a retried state e-mail sends the identical body); absent, now.
   */
  printedAt?: Date;
}

/** A page number when the caller gives no words: numbers only, no copy in the kernel. */
const BARE_PAGE_TEXT = "{n} / {total}";
const INK = "#1f2937";
const RULE = "#d1d5db";
const HEAD = "#1f3a5f";
/** Space left under a table that has no height of its own. */
const BOTTOM_MARGIN = 40;
const DATA_URI = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;

interface PreparedTable {
  block: Block;
  columns: ExportColumn[];
  /** Text of each body row, and the totals row (marked) last when there is one. */
  rows: { cells: string[]; total: boolean }[];
  rowHeight: number;
  perPage: number;
}

async function prepareTable(block: Block, source: TableSource | undefined, pageHeight: number, options: RenderOptions): Promise<PreparedTable | null> {
  if (!source) return null;
  const columns = block.columns
    ? block.columns.map((field) => source.columns.find((c) => c.field === field)).filter((c): c is ExportColumn => c !== undefined)
    : [...source.columns];
  if (columns.length === 0) return null;
  const { body, totals } = await pdfTable(columns, source.rows, options);
  // A field the caller sees masked prints empty (rule 14, spec §6), its header kept.
  const blank = columns.map((c) => c.masked === true);
  const rows = body.map((cells) => ({ cells: cells.map((cell, i) => (blank[i] ? "" : cell)), total: false }));
  if (totals) rows.push({ cells: totals.map((cell, i) => (blank[i] ? "" : cell)), total: true });
  const size = block.font?.size ?? 8;
  const rowHeight = Math.ceil(size * 1.5) + 4;
  const available = block.h ?? Math.max(rowHeight * 2, pageHeight - block.y - BOTTOM_MARGIN);
  const perPage = Math.max(1, Math.floor(available / rowHeight) - 1);
  return { block, columns, rows, rowHeight, perPage };
}

const pagesOf = (table: PreparedTable): number => Math.max(1, Math.ceil(table.rows.length / table.perPage));

function textStyle(block: Block) {
  const size = block.font?.size ?? 9;
  return {
    position: "absolute" as const,
    left: block.x,
    top: block.y,
    width: block.w,
    ...(block.h ? { height: block.h } : {}),
    fontSize: size,
    fontFamily: block.font?.bold ? "Helvetica-Bold" : "Helvetica",
    textAlign: block.align ?? "left",
    lineHeight: 1.2,
  };
}

function textBlock(block: Block, key: string, text: string): ReactElement | null {
  if (text === "") return null;
  const size = block.font?.size ?? 9;
  // With a height, the lines that fit (`maxLines`, a style @react-pdf/layout reads and its types leave out); the rest is clipped.
  const style = { ...textStyle(block), ...(block.h ? { maxLines: Math.max(1, Math.floor(block.h / (size * 1.2))) } : {}) };
  return h(Text, { key, style }, text);
}

function tablePage(table: PreparedTable, page: number, key: string): ReactElement | null {
  const slice = table.rows.slice(page * table.perPage, (page + 1) * table.perPage);
  if (slice.length === 0 && page > 0) return null;
  const { block, columns, rowHeight } = table;
  const weight = columns.reduce((sum, c) => sum + WEIGHT[c.type], 0) || 1;
  const size = block.font?.size ?? 8;
  const cell = (column: ExportColumn, value: string, i: number, bold: boolean) => {
    // `maxLines` is a style of @react-pdf/layout its types leave out: one line per cell, the rest clipped.
    const style = {
      maxLines: 1,
      width: (WEIGHT[column.type] / weight) * block.w,
      paddingHorizontal: 3,
      fontFamily: bold ? "Helvetica-Bold" : "Helvetica",
      textAlign: NUMERIC.has(column.type) ? ("right" as const) : ("left" as const),
    };
    return h(Text, { key: `${column.field}-${i}`, style }, value);
  };
  const row = (cells: string[], r: number, kind: "head" | "body" | "total") =>
    h(
      View,
      {
        key: `${kind}-${r}`,
        style: {
          flexDirection: "row",
          alignItems: "center",
          height: rowHeight,
          ...(kind === "head" ? { backgroundColor: HEAD, color: "#ffffff" } : { borderBottomWidth: 0.5, borderBottomColor: RULE }),
          ...(kind === "total" ? { borderTopWidth: 1, borderTopColor: INK } : {}),
        },
      },
      ...columns.map((column, i) => cell(column, cells[i] ?? "", i, kind !== "body")),
    );
  return h(
    View,
    { key, style: { position: "absolute", left: block.x, top: block.y, width: block.w, fontSize: size } },
    row(columns.map((c) => c.label), 0, "head"),
    ...slice.map((r, i) => row(r.cells, i, r.total ? "total" : "body")),
  );
}

/**
 * The PDF of `template` with `vars` (resolveVariables), the rows of its `lines` blocks and, optionally, a background PDF (its bytes).
 * Throws when the background is not a readable PDF.
 */
export async function renderTemplatePdf(template: Template, vars: Readonly<Record<string, string>>, rows?: TableSource, background?: Uint8Array, options: RenderOptions = {}): Promise<Buffer> {
  const base = background ? await PDFDocument.load(background) : null;
  if (base && base.getPageCount() === 0) throw new Error("the background PDF has no pages");
  const [width, height] = base
    ? (() => {
        const size = base.getPage(0).getSize();
        return [size.width, size.height] as const;
      })()
    : template.scope === "record"
      ? ([A4.short, A4.long] as const)
      : ([A4.long, A4.short] as const);

  const tables = new Map<Block, PreparedTable>();
  for (const block of template.blocks) {
    if (block.kind !== "lines") continue;
    const table = await prepareTable(block, rows, height, options);
    if (table) tables.set(block, table);
  }
  const total = Math.max(1, ...[...tables.values()].map(pagesOf));
  const pageWords = options.pageText || BARE_PAGE_TEXT;

  const pages: ReactElement[] = [];
  for (let p = 0; p < total; p++) {
    const children = template.blocks.map((block, i): ReactElement | null => {
      const key = `${p}-${i}`;
      switch (block.kind) {
        case "text":
          return textBlock(block, key, block.value ?? "");
        case "variable":
        case "field":
          return textBlock(block, key, vars[block.value ?? ""] ?? "");
        case "page_number":
          return textBlock(block, key, (block.value || pageWords).replaceAll("{n}", String(p + 1)).replaceAll("{total}", String(total)));
        case "image": {
          const src = vars[block.value ?? ""] ?? "";
          if (!DATA_URI.test(src)) return null;
          return h(Image, { key, src, style: { position: "absolute", left: block.x, top: block.y, width: block.w, height: block.h ?? block.w, objectFit: "contain" } });
        }
        case "lines": {
          const table = tables.get(block);
          return table ? tablePage(table, p, key) : null;
        }
      }
    });
    pages.push(h(Page, { key: p, size: [width, height], style: { fontFamily: "Helvetica", fontSize: 9, color: INK } }, ...children.filter((c): c is ReactElement => c !== null)));
  }
  const printedAt = options.printedAt ?? new Date();
  const overlay = await renderToBuffer(h(Document, { title: template.name, creator: "Goliatt", producer: "Goliatt", creationDate: printedAt, modificationDate: printedAt }, ...pages));
  if (!base) return overlay;

  // The background under the blocks, as vector pages: the first page under the first, the second (or the first again) under the rest.
  const out = await PDFDocument.create({ updateMetadata: false });
  out.setTitle(template.name);
  out.setCreator("Goliatt");
  out.setProducer("Goliatt");
  out.setCreationDate(printedAt);
  out.setModificationDate(printedAt);
  const [first, second] = await out.embedPdf(base, base.getPageCount() > 1 ? [0, 1] : [0]);
  const top = await PDFDocument.load(overlay, { updateMetadata: false });
  const drawn = await out.embedPdf(top, top.getPageIndices());
  drawn.forEach((layer, i) => {
    const page = out.addPage([width, height]);
    page.drawPage(i === 0 ? first! : (second ?? first!), { x: 0, y: 0, width, height });
    page.drawPage(layer, { x: 0, y: 0, width, height });
  });
  return Buffer.from(await out.save({ useObjectStreams: false }));
}
