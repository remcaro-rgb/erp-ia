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
import { inFileDuplicates, mapSheet } from "../import/map";
import { decodeText, ImportFileError, MAX_IMPORT_ROWS, parseCsv, parseImportFile } from "../import/parse";
import { MAX_XLSX_UNCOMPRESSED_BYTES, readZipParts } from "../import/zip";
import { buildTemplate } from "../import/template";
import { buildZip, deflatedZeros, forgedZip, partOf } from "../import/zip-fixtures";

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
    const declared = forgedZip({ data: new Uint8Array([1]), method: 0, declaredSize: MAX_XLSX_UNCOMPRESSED_BYTES + 1 });
    expect(() => readZipParts(declared)).toThrow("El libro de Excel es demasiado grande al descomprimirlo");
    await expect(parseImportFile(declared, "bomba.xlsx")).rejects.toBeInstanceOf(ImportFileError);
  });

  it("refuses an XLSX part that declares 1 KB but really inflates past the cap, without inflating it whole", async () => {
    // 256 MB of zeros deflate to ~260 KB; the zip claims 1 KB. The check inflates at most the 64 MB cap, then stops.
    const real = 4 * MAX_XLSX_UNCOMPRESSED_BYTES;
    const bomb = forgedZip({ data: await deflatedZeros(real), method: 8, declaredSize: 1024 });
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    expect(() => readZipParts(bomb)).toThrow("El libro de Excel es demasiado grande al descomprimirlo");
    // What the inflater held is bounded by the cap (plus slack), never the real inflated size.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(MAX_XLSX_UNCOMPRESSED_BYTES + 8 * 1024 * 1024);
    await expect(parseImportFile(bomb, "bomba.xlsx")).rejects.toThrow("demasiado grande");
    // A small honest part passes.
    const honest = forgedZip({ data: await deflatedZeros(4096), method: 8, declaredSize: 4096 });
    // (forgedZip declares a zero CRC: an honest part is built with partOf.)
    expect(() => readZipParts(honest)).toThrow("estructura zip");
    expect(readZipParts(buildZip([partOf("a.xml", new Uint8Array(4096))]))[0]!.data.byteLength).toBe(4096);
  });

  it("refuses a zip whose end record understates its parts, with a bomb as the second record, before inflating anything", async () => {
    // JSZip walks central records by signature and ignores the end record's count: this archive would reach ExcelJS
    // with the bomb inside. The strict reader refuses the incoherent directory (and ExcelJS never sees the upload).
    const real = 4 * MAX_XLSX_UNCOMPRESSED_BYTES;
    const bomb = { name: "xl/worksheets/sheet1.xml", method: 8 as const, payload: await deflatedZeros(real), size: 1024, crc: 0 };
    const zip = buildZip([partOf("[Content_Types].xml", new TextEncoder().encode("<Types/>")), bomb], { eocdEntries: 1 });
    const before = process.memoryUsage().arrayBuffers;
    expect(() => readZipParts(zip)).toThrow("estructura zip no es coherente");
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(8 * 1024 * 1024);
    await expect(parseImportFile(zip, "doble.xlsx")).rejects.toThrow("estructura zip no es coherente");
  });

  it("refuses a part whose local header names another file than its central record", async () => {
    const zip = buildZip([{ ...partOf("xl/workbook.xml", new TextEncoder().encode("<workbook/>")), localName: "xl/evil.xml" }]);
    expect(() => readZipParts(zip)).toThrow("estructura zip no es coherente");
    await expect(parseImportFile(zip, "nombres.xlsx")).rejects.toBeInstanceOf(ImportFileError);
  });

  it("refuses bytes between the central directory and the end record, and a trailing central record", () => {
    const honest = buildZip([partOf("a.xml", new Uint8Array(10)), partOf("b.xml", new Uint8Array(10))]);
    // The end record says 1 part: the walk finds 2 central records.
    const understated = buildZip([partOf("a.xml", new Uint8Array(10)), partOf("b.xml", new Uint8Array(10))], { eocdEntries: 1 });
    expect(() => readZipParts(understated)).toThrow("estructura zip");
    const gap = new Uint8Array(honest.byteLength + 4);
    gap.set(honest.subarray(0, honest.byteLength - 22), 0);
    gap.set(honest.subarray(honest.byteLength - 22), honest.byteLength - 22 + 4);
    expect(() => readZipParts(gap)).toThrow("estructura zip");
    expect(readZipParts(honest).map((p) => p.name)).toEqual(["a.xml", "b.xml"]);
  });

  it("reads a workbook written the LibreOffice way (data descriptors), rebuilt from its parts", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Hoja");
    sheet.addRow(["name", "price"]);
    sheet.addRow(["Uno", 1.5]);
    const parts = readZipParts(new Uint8Array(await book.xlsx.writeBuffer()));
    const libre = buildZip(
      parts.map((p) => partOf(p.name, p.data)),
      { dataDescriptor: true },
    );
    const parsed = await parseImportFile(libre, "libre.xlsx");
    expect(parsed.headers).toEqual(["name", "price"]);
    expect(parsed.rows).toEqual([{ rowNo: 2, cells: ["Uno", 1.5] }]);
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

  it("drops the quote errores.csv puts before a formula-like value, so a corrected errores.csv imports as the original", () => {
    const mapped = mapSheet(columns(), sheet(["Nombre", "Precio", "Nota"], ["'+57 300", "'-12,5", "'hola"]), LABELS);
    expect(mapped.records[0]!.input).toMatchObject({ name: "+57 300", price: -12.5, note: "'hola" });
    expect(mapped.records[0]!.raw).toMatchObject({ Nombre: "+57 300", Precio: "-12,5" });
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
  const columns = () => importColumns(gadgetRegistry(), "gadgets.gadget");
  const rows = (...names: string[]) =>
    mapSheet(columns(), { headers: ["Nombre"], rows: names.map((name, i) => ({ rowNo: i + 2, cells: [name] })) }, LABELS).records.map((record, index) => ({ index, record }));

  it("refuse the second and later valid rows that repeat the key, naming the first row; blank keys are left to the process", () => {
    const all = rows("Uno", " uno ", "", "", "UNO");
    const found = inFileDuplicates(columns(), all, ["name"], LABELS);
    expect([...found]).toEqual([
      [1, "Nombre: repetido en el archivo (igual a la fila 2)"],
      [4, "Nombre: repetido en el archivo (igual a la fila 2)"],
    ]);
  });

  it("count only the rows given (the valid ones): a corrected copy of a refused row is not a duplicate", () => {
    const all = rows("Uno", "Uno");
    // Row 2 was refused by the dry run; only row 3 is valid.
    expect(inFileDuplicates(columns(), [all[1]!], ["name"], LABELS).size).toBe(0);
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
