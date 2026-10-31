import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inflateSync } from "node:zlib";
import { EXPORT_PAGE_SIZE } from "../exports/types";
import { renderReportFile, reportExportColumns, reportPdfHeader } from "../exports/report";
import { defineReport } from "../reports";
import { exportColumns } from "../exports/columns";
import { writeCsv } from "../exports/csv";
import { cellText, isoWithOffset, MASK } from "../exports/format";
import { pdfTable, writePdf } from "../exports/pdf";
import type { ExportColumn } from "../exports/types";
import { writeXlsx } from "../exports/xlsx";
import { groupedColumns, groupedRows } from "../exports/grouped";
import { buildQuery } from "../query";
import { defineEntity } from "../registry";
import type { GridAccess } from "../query/run";

// The three export writers (design §9, rule 20): CSV, Excel and PDF share one column model. A masked column prints
// `••••••` in all of them (rule 14), money is a number in Excel and `$ 1.234.567,00` on paper, and a text cell that
// could run as a formula in a spreadsheet is defused in CSV.

const columns: ExportColumn[] = [
  { field: "seq", label: "N.º", type: "number" },
  { field: "legal_name", label: "Razón social", type: "text" },
  { field: "document_number", label: "Documento", type: "text", masked: true },
  { field: "credit_limit", label: "Cupo", type: "money" },
  { field: "created_at", label: "Creada", type: "datetime" },
  { field: "since", label: "Desde", type: "date" },
  { field: "is_active", label: "Activo", type: "boolean" },
  { field: "kind", label: "Tipo", type: "enum", options: { customer: "Cliente", supplier: "Proveedor" } },
];

const rows = [
  {
    seq: 1,
    legal_name: 'Café "del Norte"; S.A.S.',
    document_number: null,
    credit_limit: "1234567.5000",
    created_at: new Date("2026-10-28T15:30:00Z"),
    since: new Date("2026-03-05T00:00:00Z"),
    is_active: true,
    kind: ["customer", "supplier"],
  },
  { seq: 2, legal_name: "=HYPERLINK(\"http://evil\")", document_number: "900373115", credit_limit: "-50.0000", created_at: null, since: null, is_active: false, kind: "supplier" },
  { seq: 3, legal_name: "Línea uno\nlínea dos", document_number: "1", credit_limit: 0, created_at: new Date("2026-01-02T05:00:00Z"), since: "2026-01-02", is_active: true, kind: "customer" },
];

async function text(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; text: string }> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return { bytes, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
}

describe("writeCsv", () => {
  it("starts with the UTF-8 BOM, separates with ; for es-419 and ends lines with CRLF", async () => {
    const { bytes, text: csv } = await text(writeCsv(columns, rows, { locale: "es-419", timeZone: "America/Bogota" }));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe('"N.º";"Razón social";"Documento";"Cupo";"Creada";"Desde";"Activo";"Tipo"');
    expect(lines.at(-1)).toBe("");
    expect(csv).not.toMatch(/[^\r]\n(?!línea)/);
  });

  it("quotes text with the quote doubled, keeps line breaks inside quotes and uses , for en", async () => {
    const es = (await text(writeCsv(columns, rows, { locale: "es-419" }))).text;
    expect(es).toContain('"Café ""del Norte""; S.A.S."');
    expect(es).toContain('"Línea uno\nlínea dos"');
    const en = (await text(writeCsv(columns, rows, { locale: "en" }))).text;
    expect(en.slice(1).split("\r\n")[0]).toBe('"N.º","Razón social","Documento","Cupo","Creada","Desde","Activo","Tipo"');
  });

  it("writes dates in ISO, money and numbers bare with the locale's decimal mark, booleans and enums as labels", async () => {
    const [header, first, second, third] = (await text(writeCsv(columns, rows, { locale: "es-419" }))).text.slice(1).split("\r\n");
    expect(header).toBeDefined();
    expect(first).toBe('1;"Café ""del Norte""; S.A.S.";"••••••";1234567,50;2026-10-28T15:30:00+00:00;2026-03-05;"Sí";"Cliente, Proveedor"');
    expect(second!.startsWith("2;")).toBe(true);
    expect(second).toContain(';-50,00;;;"No";"Proveedor"');
    expect(third).toContain(";0,00;2026-01-02T05:00:00+00:00;2026-01-02;");
    const en = (await text(writeCsv(columns, rows, { locale: "en" }))).text.split("\r\n")[1];
    expect(en).toContain(",1234567.50,");
    expect(en).toContain('"Yes"');
  });

  it("writes a datetime in ISO with the company's zone offset (rule 8), and the same instant in UTC without a zone", async () => {
    const bogota = (await text(writeCsv([columns[4]!], rows, { locale: "es-419", timeZone: "America/Bogota" }))).text.slice(1).split("\r\n");
    expect(bogota.slice(1, 4)).toEqual(["2026-10-28T10:30:00-05:00", "", "2026-01-02T00:00:00-05:00"]);
    const kolkata = (await text(writeCsv([columns[4]!], rows, { locale: "es-419", timeZone: "Asia/Kolkata" }))).text.slice(1).split("\r\n");
    expect(kolkata[1]).toBe("2026-10-28T21:00:00+05:30");
    expect(isoWithOffset(new Date("2026-10-28T15:30:00Z"), undefined)).toBe("2026-10-28T15:30:00+00:00");
  });

  it("prints a masked column as •••••• on every row, whatever the row holds", async () => {
    const csv = (await text(writeCsv(columns, rows, { locale: "es-419" }))).text;
    expect(csv.match(new RegExp(MASK, "g"))).toHaveLength(3);
    expect(csv).not.toContain("900373115");
  });

  it("defuses a text cell that starts like a formula, but not a negative number", async () => {
    const csv = (await text(writeCsv(columns, [{ ...rows[1]!, legal_name: "@SUM(A1)" }, { ...rows[1]!, legal_name: "+1" }, { ...rows[1]!, legal_name: "-2" }], { locale: "es-419" }))).text;
    expect(csv).toContain(`"'@SUM(A1)"`);
    expect(csv).toContain(`"'+1"`);
    expect(csv).toContain(`"'-2"`);
    expect(csv).toContain(";-50,00;");
    expect(cellText({ field: "t", label: "t", type: "text" }, "=1+1", { locale: "es-419" })).toBe("=1+1");
  });

  it("defuses a header that starts like a formula too (an admin's label)", async () => {
    const csv = (await text(writeCsv([{ field: "x", label: "=cmd|' /C calc'!A0", type: "text" }], [], { locale: "es-419" }))).text;
    expect(csv.slice(1)).toBe(`"'=cmd|' /C calc'!A0"\r\n`);
  });

  it("streams rows from an async source and stops reading when the consumer cancels", async () => {
    let produced = 0;
    async function* source() {
      for (let i = 1; i <= 1000; i++) {
        produced = i;
        yield { seq: i, legal_name: `N${i}` };
      }
    }
    const small: ExportColumn[] = [columns[0]!, columns[1]!];
    const all = await text(writeCsv(small, source(), { locale: "es-419" }));
    expect(all.text.split("\r\n")).toHaveLength(1002);
    produced = 0;
    const reader = writeCsv(small, source(), { locale: "es-419" }).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    expect(produced).toBeLessThan(1000);
  });
});

describe("writeXlsx", () => {
  async function load(): Promise<ExcelJS.Worksheet> {
    const buffer = await writeXlsx(columns, rows, { title: "Terceros", locale: "es-419", timeZone: "America/Bogota" });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    return book.getWorksheet("Terceros")!;
  }

  it("freezes the header row, filters every column over the data and bolds the headers", async () => {
    const sheet = await load();
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBe("A1:H4");
    expect(sheet.getRow(1).values).toEqual([undefined, "N.º", "Razón social", "Documento", "Cupo", "Creada", "Desde", "Activo", "Tipo"]);
    expect(sheet.getRow(1).font?.bold).toBe(true);
  });

  it("keeps types: money is a number with #,##0.00, dates are dates, a masked value is text", async () => {
    const sheet = await load();
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe(1);
    expect(typeof row.getCell(4).value).toBe("number");
    expect(row.getCell(4).value).toBe(1234567.5);
    expect(row.getCell(4).numFmt).toBe("#,##0.00");
    expect(sheet.getRow(3).getCell(4).value).toBe(-50);
    expect(row.getCell(6).value).toBeInstanceOf(Date);
    expect((row.getCell(6).value as Date).toISOString().slice(0, 10)).toBe("2026-03-05");
    expect(row.getCell(5).value).toBeInstanceOf(Date);
    // 15:30 UTC is 10:30 in Bogotá: Excel has no zones, so the cell holds the wall clock of the company.
    expect((row.getCell(5).value as Date).toISOString()).toBe("2026-10-28T10:30:00.000Z");
    expect(row.getCell(3).value).toBe(MASK);
    expect(sheet.getRow(3).getCell(3).value).toBe(MASK);
    expect(row.getCell(7).value).toBe("Sí");
    expect(row.getCell(8).value).toBe("Cliente, Proveedor");
    expect(sheet.getRow(3).getCell(5).value).toBeNull();
  });

  it("names the sheet after the title without the characters Excel forbids", async () => {
    const buffer = await writeXlsx(columns, [], { title: "Terceros: [2026] / *todos*?", locale: "es-419" });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(book.worksheets[0]!.name).toBe("Terceros 2026 todos");
    expect(book.worksheets[0]!.rowCount).toBe(1);
  });
});

describe("writePdf", () => {
  const options = { title: "Terceros", company: "Café del Norte S.A.S.", locale: "es-419", timeZone: "America/Bogota" };

  it("renders a PDF buffer", async () => {
    const pdf = await writePdf(columns, rows, options);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("paginates a long table in landscape", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...rows[0]!, seq: i + 1 }));
    const pdf = (await writePdf(columns, many, options)).toString("latin1");
    expect(Number(/\/Count (\d+)/.exec(pdf)?.[1])).toBeGreaterThan(2);
    // A4 landscape: 841.89 x 595.28 points.
    expect(pdf).toMatch(/MediaBox \[0 0 841\.89\d* 595\.28\d*\]/);
  });

  it("prints the masked column as •••••• on every row and totals only the money it may show", async () => {
    const table = await pdfTable(columns, rows, { locale: "es-419", timeZone: "America/Bogota" });
    expect(table.body.map((row) => row[2])).toEqual([MASK, MASK, MASK]);
    expect(table.body[0]).toEqual(["1", 'Café "del Norte"; S.A.S.', MASK, "$ 1.234.567,50", "2026/10/28 10:30", "2026/03/05", "Sí", "Cliente, Proveedor"]);
    expect(table.body[1]![3]).toBe("-$ 50,00");
    expect(table.totals).toEqual(["Total", "", "", "$ 1.234.517,50", "", "", "", ""]);
    const hidden = await pdfTable(columns.filter((c) => c.field !== "credit_limit"), rows, { locale: "en" });
    expect(hidden.totals).toBeNull();
    expect(JSON.stringify(table.body)).not.toContain("900373115");
  });

  it("shows what the page shows: money as $ 1.234.567,00, a masked cell as ••••••", () => {
    const money = columns[3]!;
    expect(cellText(money, "1234567.5000", { locale: "es-419", paper: true })).toBe("$ 1.234.567,50");
    expect(cellText(money, "-50", { locale: "en", paper: true })).toBe("-$ 50,00");
    expect(cellText(columns[2]!, "900373115", { locale: "es-419", paper: true })).toBe(MASK);
    expect(cellText(columns[4]!, new Date("2026-10-28T15:30:00Z"), { locale: "es-419", timeZone: "America/Bogota", paper: true })).toBe("2026/10/28 10:30");
    expect(cellText(columns[5]!, new Date("2026-03-05T00:00:00Z"), { locale: "es-419", paper: true })).toBe("2026/03/05");
  });
});

describe("exportColumns", () => {
  const entity = defineEntity({
    id: "core.party",
    module: "core",
    schema: "core",
    table: "parties",
    label: "entity.core.party",
    displayField: "legal_name",
    defaultSort: { field: "legal_name", dir: "asc" },
    fields: [
      { name: "seq", type: "number", label: "field.seq" },
      { name: "legal_name", type: "text", label: "field.legal_name" },
      { name: "document_number", type: "text", label: "field.document_number" },
      { name: "credit_limit", type: "money", label: "field.credit_limit" },
      { name: "kind", type: "enum", label: "field.kind", enumValues: ["customer", "supplier"] },
      { name: "extra", type: "json", label: "field.extra" },
    ],
  });
  const access: GridAccess = {
    modes: { seq: "visible", legal_name: "visible", document_number: "masked", credit_limit: "hidden", kind: "visible", extra: "visible" },
    extras: [
      { key: "ruta", label: "Ruta", type: "text", options: null, viewable: true },
      { key: "peso", label: "Peso", type: "number", options: null, viewable: true },
      { key: "secreto", label: "Secreto", type: "text", options: null, viewable: false },
    ],
    timeZone: "America/Bogota",
  };
  const state = (columns?: string[]) => ({ filters: [], sort: [], page: 1, pageSize: 25, ...(columns ? { columns } : {}) });
  const names = (list: ExportColumn[]) => list.map((c) => c.field);

  it("keeps the visible columns in the state's order, marks masked ones and leaves hidden ones out", () => {
    const list = exportColumns(entity, access, state(["legal_name", "credit_limit", "seq", "document_number"]), {});
    expect(names(list)).toEqual(["legal_name", "seq", "document_number"]);
    expect(list.find((c) => c.field === "document_number")?.masked).toBe(true);
    expect(list.find((c) => c.field === "legal_name")?.masked).toBeUndefined();
  });

  it("never exports the technical id, takes the labels it is given and falls back to the field name", () => {
    const list = exportColumns(entity, access, state(["id", "legal_name", "kind"]), { labels: { legal_name: "Razón social" }, values: { kind: { customer: "Cliente" } } });
    expect(names(list)).toEqual(["legal_name", "kind"]);
    expect(list[0]!.label).toBe("Razón social");
    expect(list[1]!.label).toBe("kind");
    expect(list[1]!.options).toEqual({ customer: "Cliente" });
    expect(list[1]!.type).toBe("enum");
  });

  it("exports the admin-defined fields the caller's roles may view, by their own labels, and expands the collapsed `extra`", () => {
    const named = exportColumns(entity, access, state(["legal_name", "extra.ruta", "extra.secreto", "extra.peso"]), {});
    expect(names(named)).toEqual(["legal_name", "extra.ruta", "extra.peso"]);
    expect(named[1]).toMatchObject({ label: "Ruta", type: "text" });
    expect(named[2]).toMatchObject({ label: "Peso", type: "number" });
    expect(names(exportColumns(entity, access, state(["legal_name", "extra"]), {}))).toEqual(["legal_name", "extra.ruta", "extra.peso"]);
    expect(names(exportColumns(entity, { ...access, modes: { ...access.modes, extra: "hidden" } }, state(["legal_name", "extra.ruta"]), {}))).toEqual(["legal_name"]);
  });

  it("without a column list, exports every visible field of the entity (no id, no raw extra) and the viewable extras", () => {
    expect(names(exportColumns(entity, access, state(), {}))).toEqual(["seq", "legal_name", "document_number", "kind", "extra.ruta", "extra.peso"]);
  });

  it("an entity without an `extra` field gets no extra column by default and refuses the name", () => {
    const plain = defineEntity({ ...entity, id: "core.plain", fields: entity.fields.filter((f) => f.name !== "extra") });
    expect(names(exportColumns(plain, { ...access, extras: [] }, state(), {}))).toEqual(["seq", "legal_name", "document_number", "kind"]);
    expect(() => exportColumns(plain, access, state(["extra"]), {})).toThrow(/extra/);
  });

  it("refuses a column the entity does not have", () => {
    expect(() => exportColumns(entity, access, state(["nope"]), {})).toThrow(/nope/);
  });
});

describe("buildQuery window", () => {
  const entity = defineEntity({
    id: "core.thing",
    module: "core",
    schema: "core",
    table: "things",
    label: "entity.core.thing",
    displayField: "name",
    defaultSort: { field: "name", dir: "asc" },
    fields: [{ name: "name", type: "text", label: "field.name" }],
  });

  it("pages by a window of its own (an export reads 1,000 rows at a time, beyond the grid's page size)", () => {
    const q = buildQuery(entity, { filters: [], sort: [], page: 1, pageSize: 25 }, () => true, { window: { offset: 2000, limit: 1000 } });
    expect(q.sql).toMatch(/limit 1000 offset 2000$/);
    expect(() => buildQuery(entity, { filters: [], sort: [], page: 1, pageSize: 25 }, () => true, { window: { offset: -1, limit: 1000 } })).toThrow();
  });
});


describe("report export", () => {
  const def = defineReport({
    id: "probe.ledger",
    module: "probe",
    feature: "probe.reports",
    label: "report.probe.ledger",
    params: z.object({ to: z.string() }),
    consult: "probe.ledger.consult",
    columns: [
      { field: "code", label: "Código", type: "text" },
      { field: "balance", label: "Saldo", type: "money", total: "sum" },
    ],
    totals: ["balance"],
    pdfTitle: "Balance de prueba",
  });
  const TOTAL = 2500;
  const calls: { page: number; pageSize: number }[] = [];
  const source = {
    def,
    params: { to: "2026-10-31" },
    company: "Café del Norte S.A.S.",
    taxId: "900373115-3",
    timeZone: "America/Bogota",
    locale: "es-419",
    paramsText: "Hasta: 2026-10-31",
    async consult(state: { page: number; pageSize: number }) {
      calls.push({ page: state.page, pageSize: state.pageSize });
      const from = (state.page - 1) * state.pageSize;
      const rows = Array.from({ length: Math.max(0, Math.min(state.pageSize, TOTAL - from)) }, (_, i) => ({ code: `1105${from + i}`, balance: "1000.0000" }));
      return { rows, total: TOTAL };
    },
  };

  it("export of a report reads every window and writes the pdf header with company, NIT and params", async () => {
    calls.length = 0;
    const xlsx = await renderReportFile(source, { id: def.id, params: source.params, format: "xlsx" });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(xlsx.body as Buffer) as never);
    expect(book.worksheets[0]!.actualRowCount).toBe(TOTAL + 1);
    expect(xlsx.rowCount()).toBe(TOTAL);
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(calls.every((c) => c.pageSize === EXPORT_PAGE_SIZE)).toBe(true);

    const lines = reportPdfHeader(source);
    expect(lines).toEqual({ title: "Balance de prueba", company: "Café del Norte S.A.S.", taxId: "900373115-3", params: "Hasta: 2026-10-31" });
    const table = await pdfTable(reportExportColumns(def), [{ code: "1", balance: "10.0000" }, { code: "2", balance: "5.5000" }], { locale: "es-419", totalFields: def.totals });
    expect(table.totals).toEqual(["Total", "$ 15,50"]);
    const pdf = await renderReportFile({ ...source, consult: async (s) => ({ rows: s.page === 1 ? [{ code: "1", balance: "1.0000" }] : [], total: 1 }) }, { id: def.id, params: source.params, format: "pdf" });
    const text = pdfText(pdf.body as Buffer);
    expect(text).toContain("900373115-3");
    expect(text).toContain("Balance de prueba");
  });
});

/** The strings a PDF prints: every Flate stream inflated, literal and hex strings of the text operators read back. */
function pdfText(pdf: Buffer): string {
  const out: string[] = [];
  let at = 0;
  const raw = pdf.toString("latin1");
  for (;;) {
    const start = raw.indexOf("stream", at);
    if (start === -1) break;
    const from = raw[start + 6] === "\r" ? start + 8 : start + 7;
    const end = raw.indexOf("endstream", from);
    try {
      out.push(inflateSync(pdf.subarray(from, end)).toString("latin1"));
    } catch {
      out.push(raw.slice(from, end));
    }
    at = end + 9;
  }
  const decoded = out.join("\n");
  const hex = [...decoded.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1"));
  const literal = [...decoded.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1]!);
  return [...hex, ...literal].join("");
}

describe("grouped export", () => {
  const base: ExportColumn[] = [
    { field: "account_code", label: "Cuenta", type: "text" },
    { field: "debit", label: "Débito", type: "money" },
  ];
  const lines = [
    { account_code: "1105", debit: "100.0000", __keys: { account_code: "1105" } },
    { account_code: "1105", debit: "50.0000", __keys: { account_code: "1105" } },
    { account_code: "2205", debit: "25.0000", __keys: { account_code: "2205" } },
  ];
  const spec = {
    fields: ["account_code"],
    groups: [
      { level: 1, keys: { account_code: "1105" }, count: 2, aggregates: { "sum:debit": "150.0000" } },
      { level: 1, keys: { account_code: "2205" }, count: 1, aggregates: { "sum:debit": "25.0000" } },
    ],
    grand: { "sum:debit": "175.0000" },
    fns: ["sum" as const],
    valueFields: ["debit"],
  };

  it("xlsx export with groupBy writes a Grupo column, subtotal rows and a grand total", async () => {
    const buffer = await writeXlsx(groupedColumns(base), groupedRows(lines, spec), { title: "Movimientos", locale: "es-419" });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("Movimientos")!;
    const table = sheet.getSheetValues().slice(1).map((r) => (r as unknown[]).slice(1));
    expect(table).toEqual([
      ["Grupo", "Cuenta", "Débito"],
      ["1105", "1105", 100],
      ["1105", "1105", 50],
      ["Total 1105", undefined, 150],
      ["2205", "2205", 25],
      ["Total 2205", undefined, 25],
      ["Total general", undefined, 175],
    ]);
    // Excel outline: lines at level 1, group summaries at 0.
    expect(sheet.getRow(2).outlineLevel).toBe(1);
    expect(sheet.getRow(4).outlineLevel).toBe(0);
    expect(sheet.getRow(4).font?.bold).toBe(true);
  });

  it("csv and pdf carry the same rows, and the pdf does not add the subtotals twice", async () => {
    const csv = await text(writeCsv(groupedColumns(base), groupedRows(lines, spec), { locale: "es-419" }));
    expect(csv.text.split("\r\n").filter(Boolean)).toEqual(['\ufeff"Grupo";"Cuenta";"Débito"', '"1105";"1105";100,00', '"1105";"1105";50,00', '"Total 1105";;150,00', '"2205";"2205";25,00', '"Total 2205";;25,00', '"Total general";;175,00']);
    const { body, totals } = await pdfTable(groupedColumns(base), groupedRows(lines, spec), { locale: "es-419" });
    expect(body.at(-1)).toEqual(["Total general", "", "$ 175,00"]);
    expect(totals).toBeNull();
  });
});
