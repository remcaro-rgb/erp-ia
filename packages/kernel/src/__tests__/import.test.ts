import ExcelJS from "exceljs";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineModule } from "../module/define";
import { loadModules } from "../module/loader";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { defineEntity, Registry } from "../registry";
import { importColumns, importTarget } from "../import/columns";
import { describeFailure, errorsCsv } from "../import/errors-csv";
import { mapSheet, markInFileDuplicates } from "../import/map";
import { checkXlsxSize, decodeText, ImportFileError, MAX_IMPORT_ROWS, MAX_XLSX_UNCOMPRESSED_BYTES, parseCsv, parseImportFile } from "../import/parse";
import { buildTemplate } from "../import/template";

// Mass import (Task 13b), the pure parts: the columns a create process accepts, the template built from them,
// the CSV / XLSX reader, the header mapping with typed coercion and errores.csv.

const gadget = defineEntity({
  id: "gadgets.gadget",
  module: "gadgets",
  schema: "gadgets",
  table: "gadgets",
  label: "entity.gadgets.gadget",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [
    { name: "name", type: "text", label: "field.gadgets.gadget.name" },
    { name: "kind", type: "enum", label: "field.gadgets.gadget.kind", enumValues: ["small", "large"] },
    { name: "tags", type: "json", label: "field.gadgets.gadget.tags" },
    { name: "price", type: "money", label: "field.gadgets.gadget.price" },
    { name: "active", type: "boolean", label: "field.gadgets.gadget.active" },
    { name: "maker_id", type: "ref", label: "field.gadgets.gadget.maker_id", ref: { entity: "gadgets.maker", display: "name" } },
  ],
});
const maker = defineEntity({
  id: "gadgets.maker",
  module: "gadgets",
  schema: "gadgets",
  table: "makers",
  label: "entity.gadgets.maker",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  processIds: { create: "gadgets.maker.add" },
  fields: [{ name: "name", type: "text", label: "field.gadgets.maker.name" }],
});

const gadgetCreate = defineProcess({
  id: "gadgets.gadget.create",
  module: "gadgets",
  kind: "create",
  description: "crea",
  input: z.object({
    name: z.string().trim().min(1),
    kind: z.enum(["small", "large"]).default("small"),
    tags: z.array(z.enum(["red", "blue"])),
    price: z.number().optional(),
    active: z.boolean(),
    makerId: z.uuid().nullable().optional(),
    note: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
    extraFree: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  }),
  output: z.object({ id: z.string() }),
  handler: async () => ({ id: "x" }),
});
const makerAdd = defineProcess({
  id: "gadgets.maker.add",
  module: "gadgets",
  kind: "create",
  description: "crea",
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async () => ({ id: "x" }),
});

function gadgetRegistry(): Registry {
  const registry = new Registry();
  loadModules(registry, [
    defineModule({
      id: "gadgets",
      version: "1",
      dependsOn: [],
      entities: [gadget, maker],
      processes: [gadgetCreate, makerAdd],
      features: [],
      events: { emits: [], consumes: {} },
      navigation: [],
    }),
  ]);
  return registry;
}

const LABELS = { name: "Nombre", kind: "Tamaño", tags: "Etiquetas", price: "Precio", active: "Activo", makerId: "Fabricante", note: "Nota" };
const bytes = (text: string) => new TextEncoder().encode(text);
/** A zip with one stored part whose central directory declares `uncompressed` bytes (nothing is unpacked to check it). */
function zipDeclaring(uncompressed: number): Uint8Array {
  const name = new TextEncoder().encode("xl/workbook.xml");
  const local = new Uint8Array(30 + name.length + 1);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint32(18, 1, true);
  lv.setUint32(22, uncompressed, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint32(20, 1, true);
  cv.setUint32(24, uncompressed, true);
  cv.setUint16(28, name.length, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  const zip = new Uint8Array(local.length + central.length + end.length);
  zip.set(local, 0);
  zip.set(central, local.length);
  zip.set(end, local.length + central.length);
  return zip;
}

/** Decodes keeping a BOM, so the tests can see it. */
const text = (data: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);

describe("import columns", () => {
  it("are the create process's input keys in order, without the extra data, typed from its schema", () => {
    const columns = importColumns(gadgetRegistry(), "gadgets.gadget");
    expect(columns.map((c) => c.key)).toEqual(["name", "kind", "tags", "price", "active", "makerId", "note"]);
    expect(columns.find((c) => c.key === "name")).toMatchObject({ field: "name", type: "text", required: true, label: "field.gadgets.gadget.name" });
    expect(columns.find((c) => c.key === "kind")).toMatchObject({ type: "list", required: false, options: ["small", "large"] });
    expect(columns.find((c) => c.key === "tags")).toMatchObject({ type: "multi", required: true, options: ["red", "blue"] });
    expect(columns.find((c) => c.key === "price")).toMatchObject({ type: "number", required: false });
    expect(columns.find((c) => c.key === "active")).toMatchObject({ type: "boolean", required: true });
    expect(columns.find((c) => c.key === "makerId")).toMatchObject({ field: "maker_id", type: "ref", ref: { entity: "gadgets.maker", display: "name" } });
    // A key with no registry field still gets a label key of the entity.
    expect(columns.find((c) => c.key === "note")).toMatchObject({ field: "note", label: "field.gadgets.gadget.note" });
  });

  it("resolve the create process from the entity id or its declared processIds.create", () => {
    const registry = gadgetRegistry();
    expect(importTarget(registry, "gadgets.gadget").createProcess.id).toBe("gadgets.gadget.create");
    expect(importTarget(registry, "gadgets.maker").createProcess.id).toBe("gadgets.maker.add");
  });

  it("refuse an unknown entity and one without a create process with invalid_input", () => {
    const registry = gadgetRegistry();
    expect(() => importTarget(registry, "gadgets.nope")).toThrow(ProcessError);
    expect(() => importTarget(registry, "gadgets.nope")).toThrow(expect.objectContaining({ code: "invalid_input" }));
    const bare = new Registry();
    bare.registerEntity(gadget);
    expect(() => importTarget(bare, "gadgets.gadget")).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });
});

describe("import templates", () => {
  it("CSV: UTF-8 with BOM, one ';'-separated header row with the labels in column order", async () => {
    const template = await buildTemplate(gadgetRegistry(), "gadgets.gadget", "csv", { labels: LABELS });
    expect(template).toMatchObject({ fileName: "plantilla_gadgets.gadget.csv", mimeType: "text/csv; charset=utf-8" });
    const csv = text(template.bytes);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).trim()).toBe("Nombre;Tamaño;Etiquetas;Precio;Activo;Fabricante;Nota");
  });

  it("CSV without labels uses the column keys", async () => {
    const template = await buildTemplate(gadgetRegistry(), "gadgets.gadget", "csv");
    expect(text(template.bytes).slice(1).trim()).toBe("name;kind;tags;price;active;makerId;note");
  });

  it("XLSX: labelled header, frozen, list columns as dropdowns, and the file reads back", async () => {
    const template = await buildTemplate(gadgetRegistry(), "gadgets.gadget", "xlsx", { labels: LABELS });
    expect(template.fileName).toBe("plantilla_gadgets.gadget.xlsx");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(template.bytes as unknown as ArrayBuffer);
    const sheet = book.worksheets[0]!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(["Nombre", "Tamaño", "Etiquetas", "Precio", "Activo", "Fabricante", "Nota"]);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    // Tamaño (column B) and Activo (column E) are dropdowns; the free text column A is not.
    expect(sheet.getCell("B2").dataValidation).toMatchObject({ type: "list" });
    expect(sheet.getCell("E2").dataValidation).toMatchObject({ type: "list" });
    expect(sheet.getCell("A2").dataValidation).toBeUndefined();
    const parsed = await parseImportFile(template.bytes, template.fileName);
    expect(parsed.headers).toEqual(["Nombre", "Tamaño", "Etiquetas", "Precio", "Activo", "Fabricante", "Nota"]);
    expect(parsed.rows).toEqual([]);
  });
});

describe("import parsing", () => {
  it("detects ';' or ',' from the header and honours quotes, doubled quotes, line breaks in quotes and CRLF", () => {
    expect(parseCsv('a;b;c\r\n1;"x;y";3\r\n')).toEqual([["a", "b", "c"], ["1", "x;y", "3"]]);
    expect(parseCsv('a,b\n"say ""hi""","two\nlines"\n')).toEqual([["a", "b"], ['say "hi"', "two\nlines"]]);
  });

  it("decodes UTF-8 (BOM removed) and falls back to Windows-1252 for files Excel saved as ANSI", () => {
    expect(decodeText(bytes("\uFEFFciudad\nBogotá"))).toBe("ciudad\nBogotá");
    expect(decodeText(new Uint8Array([0x42, 0x6f, 0x67, 0x6f, 0x74, 0xe1]))).toBe("Bogotá");
  });

  it("numbers data rows as the spreadsheet does (header = 1) and skips blank rows", async () => {
    const parsed = await parseImportFile(bytes("name;price\nUno;10\n;\n\nDos;20\n"), "datos.csv");
    expect(parsed.headers).toEqual(["name", "price"]);
    expect(parsed.rows).toEqual([
      { rowNo: 2, cells: ["Uno", "10"] },
      { rowNo: 5, cells: ["Dos", "20"] },
    ]);
  });

  it("reads typed cells from the first sheet of an XLSX", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Hoja");
    sheet.addRow(["name", "price", "active"]);
    sheet.addRow(["Uno", 1.234, true]);
    sheet.addRow([]);
    sheet.addRow([{ richText: [{ text: "D" }, { text: "os" }] }, { formula: "1+1", result: 2 }, false]);
    const file = new Uint8Array(await book.xlsx.writeBuffer());
    const parsed = await parseImportFile(file, "datos.xlsx");
    expect(parsed.rows).toEqual([
      { rowNo: 2, cells: ["Uno", 1.234, true] },
      { rowNo: 4, cells: ["Dos", 2, false] },
    ]);
  });

  it("refuses another file type, an unreadable XLSX and a file over the row limit", async () => {
    await expect(parseImportFile(bytes("x"), "datos.pdf")).rejects.toBeInstanceOf(ImportFileError);
    await expect(parseImportFile(bytes("not a zip"), "datos.xlsx")).rejects.toBeInstanceOf(ImportFileError);
    const big = "name\n" + "x\n".repeat(MAX_IMPORT_ROWS + 1);
    await expect(parseImportFile(bytes(big), "datos.csv")).rejects.toThrow(/50.000/);
  });

  it("refuses an XLSX whose parts declare more than 64 MB unpacked, before opening it", async () => {
    const bomb = zipDeclaring(MAX_XLSX_UNCOMPRESSED_BYTES + 1);
    expect(() => checkXlsxSize(bomb)).toThrow("El libro de Excel es demasiado grande al descomprimirlo");
    await expect(parseImportFile(bomb, "bomba.xlsx")).rejects.toBeInstanceOf(ImportFileError);
    expect(() => checkXlsxSize(zipDeclaring(1024))).not.toThrow();
  });

  it("refuses a file wider than 256 columns, CSV or XLSX", async () => {
    await expect(parseImportFile(bytes(`${Array.from({ length: 257 }, (_, i) => `c${i}`).join(";")}\n1\n`), "ancho.csv")).rejects.toThrow("más de 256 columnas");
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Hoja").getCell(2, 300).value = 1;
    await expect(parseImportFile(new Uint8Array(await book.xlsx.writeBuffer()), "ancho.xlsx")).rejects.toThrow("más de 256 columnas");
  });
});

describe("import mapping", () => {
  const columns = () => importColumns(gadgetRegistry(), "gadgets.gadget");
  const sheet = (headers: string[], ...rows: (string | number | boolean | null)[][]) => ({
    headers,
    rows: rows.map((cells, i) => ({ rowNo: i + 2, cells })),
  });

  it("matches headers by label, key or column name, ignoring case and accents, and lists the unknown ones", () => {
    const mapped = mapSheet(columns(), sheet(["NOMBRE", "tamano", "tags", "maker_id", "activo", "Color"], ["A", "small", "", "", "sí", "rojo"]), LABELS);
    expect(mapped.mapping).toEqual(["name", "kind", "tags", "makerId", "active", null]);
    expect(mapped.unknownHeaders).toEqual(["Color"]);
    expect(mapped.missingColumns).toEqual([]);
  });

  it("lists the required columns the header lacks", () => {
    const mapped = mapSheet(columns(), sheet(["Nombre"], ["A"]), LABELS);
    expect(mapped.missingColumns).toEqual(["tags", "active"]);
  });

  it("coerces cells to the column types and reports a cell that cannot be read", () => {
    const mapped = mapSheet(
      columns(),
      sheet(
        ["Nombre", "Tamaño", "Etiquetas", "Precio", "Activo", "Nota"],
        [" Uno ", "LARGE", "red|blue", "1.234.567,50", "Sí", ""],
        ["Dos", "", "", "31000", "no", "x"],
        ["Tres", "small", "red, blue", "12.5", 1, null],
        ["Cuatro", "small", "red", "abc", "quizás", null],
        ["Cinco", "small", "red", 1.234, true, null],
      ),
      LABELS,
    );
    const [one, two, three, four, five] = mapped.records;
    expect(one).toMatchObject({ rowNo: 2, errors: [], input: { name: "Uno", kind: "large", tags: ["red", "blue"], price: 1234567.5, active: true } });
    expect(one!.input).not.toHaveProperty("note");
    expect(two).toMatchObject({ errors: [], input: { name: "Dos", tags: [], price: 31000, active: false, note: "x" } });
    expect(two!.input).not.toHaveProperty("kind");
    expect(three).toMatchObject({ errors: [], input: { tags: ["red", "blue"], price: 12.5, active: true } });
    expect(four!.errors).toEqual(["Precio: «abc» no es un número", "Activo: «quizás» no es sí o no"]);
    expect(five).toMatchObject({ errors: [], input: { price: 1.234, active: true } });
    // The raw cells by header, for errores.csv.
    expect(one!.raw).toEqual({ Nombre: " Uno ", Tamaño: "LARGE", Etiquetas: "red|blue", Precio: "1.234.567,50", Activo: "Sí", Nota: "" });
  });
});

describe("in-file duplicates", () => {
  it("refuse the second and later rows that repeat the key, naming the first row; blank keys are left to the process", () => {
    const columns = importColumns(gadgetRegistry(), "gadgets.gadget");
    const mapped = mapSheet(columns, { headers: ["Nombre", "Tamaño"], rows: [["Uno", "small"], [" uno ", "large"], ["", "small"], ["", "small"], ["UNO", "small"]].map((cells, i) => ({ rowNo: i + 2, cells })) }, LABELS);
    markInFileDuplicates(columns, mapped.records, ["name"], LABELS);
    expect(mapped.records.map((r) => r.errors)).toEqual([[], ["Nombre: repetido en el archivo (igual a la fila 2)"], [], [], ["Nombre: repetido en el archivo (igual a la fila 2)"]]);
  });
});

describe("import failures", () => {
  const columns = () => importColumns(gadgetRegistry(), "gadgets.gadget");

  it("names the column of each schema issue with its label, and keeps the pack's messages", () => {
    const issues = gadgetCreate.input.safeParse({ tags: ["green"], active: true }).error!.issues;
    const error = new ProcessError("invalid_input", "x", { details: issues });
    expect(describeFailure(error, columns(), LABELS)).toEqual(["Nombre: obligatorio", "Etiquetas: valor no permitido (red, blue)"]);
    const pack = new ProcessError("invalid_input", "x", { details: ["31: solo dígitos"] });
    expect(describeFailure(pack, columns(), LABELS)).toEqual(["31: solo dígitos"]);
    expect(describeFailure(new ProcessError("forbidden", "x"), columns(), LABELS)).toEqual(["No tienes permiso para crear este registro"]);
    expect(describeFailure(new Error("boom"), columns(), LABELS)).toEqual(["No se pudo crear el registro"]);
  });

  it("errores.csv: BOM, ';', the row number, the reasons and the original cells", () => {
    const csv = text(errorsCsv(["Nombre", "Precio"], [{ rowNo: 3, errors: ["Precio: «abc» no es un número", "otro; motivo"], raw: { Nombre: 'Dos "B"', Precio: "abc" } }]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")).toEqual(["fila;error;Nombre;Precio", '3;"Precio: «abc» no es un número · otro; motivo";"Dos ""B""";abc', ""]);
  });

  it("errores.csv keeps cells that start like a formula as text", () => {
    const csv = text(errorsCsv(["Nombre", "Nota"], [{ rowNo: 2, errors: ["x"], raw: { Nombre: "=HYPERLINK(\"http://x\")", Nota: "@SUM(A1)" } }, { rowNo: 3, errors: ["-1"], raw: { Nombre: "+57", Nota: "ok" } }]));
    expect(csv.slice(1).split("\r\n").slice(1, 3)).toEqual(['2;x;"\'=HYPERLINK(""http://x"")";\'@SUM(A1)', "3;'-1;'+57;ok"]);
  });
});
