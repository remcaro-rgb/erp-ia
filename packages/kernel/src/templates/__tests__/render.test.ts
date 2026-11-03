import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { exportColumns } from "../../exports/columns";
import { MASK } from "../../exports/format";
import type { GridAccess } from "../../query/run";
import { defineEntity } from "../../registry";
import { defaultTemplate, printLabels } from "../defaults";
import { renderTemplatePdf } from "../render";
import { Block, TemplateBlocks, type Template } from "../schema";
import { imageBytesMatch, listVariables, resolveVariables, SYSTEM_VARIABLES, type PrintContext } from "../variables";
import { mediaBox, pageCount, pdfText } from "./pdf-text";

// PDF templates (entity types spec 2026-11-02 §6, Phase 2A.5 Task 11): the block schema, the variables a template prints (the company,
// the user, the print date, the record's fields as the caller sees them, money as `$ 1.234.567,00`, a masked field empty), the default
// template generated from the entity's fields and the renderer (@react-pdf/renderer, an optional background PDF under the blocks).

const client = defineEntity({
  id: "tp.client",
  module: "tp",
  schema: "tp_fixture",
  table: "clients",
  label: "entity.tp.client",
  entityType: "maestro",
  importKey: ["name"],
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [
    { name: "name", type: "text", label: "field.tp.client.name" },
    { name: "tax_id", type: "text", label: "field.tp.client.tax_id" },
    { name: "credit_limit", type: "money", label: "field.tp.client.credit_limit" },
    { name: "since", type: "date", label: "field.tp.client.since" },
    { name: "secret", type: "text", label: "field.tp.client.secret" },
    { name: "is_active", type: "boolean", label: "field.tp.client.is_active" },
    { name: "extra", type: "json", label: "field.tp.client.extra" },
    { name: "extra_free", type: "json", label: "field.tp.client.extra_free" },
  ],
});

const labels = { name: "Nombre", tax_id: "NIT", credit_limit: "Cupo de crédito", since: "Cliente desde", secret: "Nota interna", is_active: "Activo" };
/** A member: the credit limit masked, the internal note hidden (rule 14). */
const access: GridAccess = { modes: { credit_limit: "masked", secret: "hidden" }, extras: [], timeZone: "America/Bogota" };
const open: GridAccess = { modes: {}, extras: [], timeZone: "America/Bogota" };

const company = { name: "Café del Norte S.A.S.", nit: "900373115-3", address: "Carrera 43A # 1-50", city: "Medellín", phone: "+57 6044441234", logo: "" };
const ctxFor = (grid: GridAccess): PrintContext => ({
  company,
  user: { name: "Ana Restrepo" },
  printedAt: new Date("2026-11-02T15:04:00Z"),
  locale: "es-419",
  timeZone: "America/Bogota",
  columns: exportColumns(client, grid, {}, { labels }),
});
const record = { name: "Tienda La Esquina", tax_id: "800123456", credit_limit: "1234567.0000", since: new Date("2026-03-05T00:00:00Z"), secret: "no pagar", is_active: true };

const block = (b: Partial<Block> & Pick<Block, "kind">): Block => ({ x: 40, y: 40, w: 300, ...b });
const template = (blocks: Block[], scope: Template["scope"] = "record"): Template => ({ id: null, entity: client.id, scope, name: "Prueba", version: 1, isDefault: false, backgroundFileId: null, blocks });

describe("block schema", () => {
  it("accepts every kind with position, size, font and alignment, and refuses an unknown kind or a block off the page", () => {
    for (const kind of ["text", "variable", "field", "lines", "image", "page_number"] as const) {
      expect(Block.safeParse({ kind, x: 10, y: 20, w: 100, h: 12, font: { size: 9, bold: true }, align: "right", value: "x", columns: ["name"] }).success).toBe(true);
    }
    expect(Block.safeParse({ kind: "chart", x: 0, y: 0, w: 10 }).success).toBe(false);
    expect(Block.safeParse({ kind: "text", x: -1, y: 0, w: 10 }).success).toBe(false);
    expect(Block.safeParse({ kind: "text", x: 0, y: 0, w: 0 }).success).toBe(false);
    expect(Block.safeParse({ kind: "text", x: 0, y: 5000, w: 10 }).success).toBe(false);
    expect(Block.safeParse({ kind: "text", x: 0, y: 0, w: 10, font: { size: 200 } }).success).toBe(false);
    expect(TemplateBlocks.safeParse(Array.from({ length: 201 }, () => ({ kind: "text", x: 0, y: 0, w: 10 }))).success).toBe(false);
  });
});

describe("resolveVariables", () => {
  it("resolves the company with Café del Norte's data, the user and the print date in the company's zone", () => {
    const vars = resolveVariables(ctxFor(open), client, record);
    expect(vars["empresa.nombre"]).toBe("Café del Norte S.A.S.");
    expect(vars["empresa.nit"]).toBe("900373115-3");
    expect(vars["empresa.direccion"]).toBe("Carrera 43A # 1-50");
    expect(vars["empresa.ciudad"]).toBe("Medellín");
    expect(vars["empresa.telefono"]).toBe("+57 6044441234");
    expect(vars["empresa.logo"]).toBe("");
    expect(vars["usuario.nombre"]).toBe("Ana Restrepo");
    expect(vars.fecha_impresion).toBe("2026/11/02 10:04");
    for (const name of SYSTEM_VARIABLES) expect(vars).toHaveProperty(name);
  });

  it("formats the record's fields as paper: money as $ 1.234.567,00, dates AAAA/MM/DD, booleans Sí / No", () => {
    const vars = resolveVariables(ctxFor(open), client, record);
    expect(vars.name).toBe("Tienda La Esquina");
    expect(vars.credit_limit).toBe("$ 1.234.567,00");
    expect(vars.since).toBe("2026/03/05");
    expect(vars.is_active).toBe("Sí");
    expect(vars.secret).toBe("no pagar");
  });

  it("prints a masked field empty (not ••••••) and a hidden field empty, whatever the row holds", () => {
    const vars = resolveVariables(ctxFor(access), client, record);
    expect(vars.credit_limit).toBe("");
    expect(vars.secret ?? "").toBe("");
    expect(Object.values(vars)).not.toContain(MASK);
    expect(Object.values(vars).join(" ")).not.toContain("no pagar");
  });

  it("a list resolves the row count and the total of each money column it may print", () => {
    const rows = [record, { ...record, name: "Otro", credit_limit: "765433.0000" }];
    expect(listVariables(ctxFor(open), client, rows)).toMatchObject({ registros: "2", "total.credit_limit": "$ 2.000.000,00" });
    const masked = listVariables(ctxFor(access), client, rows);
    expect(masked.registros).toBe("2");
    expect(masked["total.credit_limit"] ?? "").toBe("");
  });
});

describe("defaultTemplate", () => {
  it("a record template has a field block for every printable field of the entity, the company header and the page number", () => {
    const t = defaultTemplate(client, "record", { labels });
    expect(t).toMatchObject({ id: null, entity: "tp.client", scope: "record", isDefault: true, version: 0, backgroundFileId: null });
    const fields = t.blocks.filter((b) => b.kind === "field").map((b) => b.value);
    expect(fields).toEqual(["name", "tax_id", "credit_limit", "since", "secret", "is_active"]);
    expect(t.blocks.filter((b) => b.kind === "variable").map((b) => b.value)).toEqual(expect.arrayContaining(["empresa.nombre", "empresa.nit", "fecha_impresion"]));
    expect(t.blocks.some((b) => b.kind === "page_number")).toBe(true);
    expect(t.blocks.filter((b) => b.kind === "text").map((b) => b.value)).toEqual(expect.arrayContaining(["Nombre", "Cupo de crédito"]));
    expect(TemplateBlocks.safeParse(t.blocks).success).toBe(true);
  });

  it("the tax id's label is the country pack's (NIT in Colombia); without one the header has no label", () => {
    const nitLabel = (t: Template) => t.blocks.filter((b) => b.kind === "text" && b.value === "NIT");
    expect(nitLabel(defaultTemplate(client, "record", { taxIdLabel: "NIT" }))).toHaveLength(1);
    expect(nitLabel(defaultTemplate(client, "record", {}))).toHaveLength(0);
  });

  it("labels the fields as the screen does, else by the registry's label keys in the catalogue, never by the raw field name when the catalogue has one", () => {
    const catalogue: Record<string, string> = { "field.tp.client.name": "Razón social", "field.tp.client.credit_limit": "Cupo" };
    const resolved = printLabels([client], (key) => catalogue[key], { name: "Nombre en pantalla" });
    expect(resolved).toMatchObject({ name: "Nombre en pantalla", credit_limit: "Cupo", since: "since" });
    const t = defaultTemplate(client, "record", { labels: printLabels([client], (key) => catalogue[key]) });
    expect(t.blocks.filter((b) => b.kind === "text").map((b) => b.value)).toEqual(expect.arrayContaining(["Razón social", "Cupo"]));
  });

  it("a list template is the company header and one table of the grid's columns", () => {
    const t = defaultTemplate(client, "list", { labels, title: "Clientes" });
    const lines = t.blocks.filter((b) => b.kind === "lines");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.columns).toBeUndefined();
    expect(t.blocks.filter((b) => b.kind === "text").map((b) => b.value)).toContain("Clientes");
  });

  it("renders every visible field of the record, the masked and hidden ones empty", async () => {
    const vars = resolveVariables(ctxFor(access), client, record);
    const text = pdfText(await renderTemplatePdf(defaultTemplate(client, "record", { labels }), vars));
    for (const shown of ["Tienda La Esquina", "800123456", "2026/03/05", "Café del Norte S.A.S.", "900373115-3", "Nombre", "Cupo de crédito"]) expect(text).toContain(shown);
    expect(text).not.toContain("1.234.567");
    expect(text).not.toContain("no pagar");
    expect(text).not.toContain(MASK);
  });
});

describe("renderTemplatePdf", () => {
  it("prints fixed text, variables, fields and the page number, on A4 portrait for a record", async () => {
    const vars = resolveVariables(ctxFor(open), client, record);
    const pdf = await renderTemplatePdf(
      template([
        block({ kind: "text", value: "Certificado de cliente", font: { size: 14, bold: true } }),
        block({ kind: "variable", y: 70, value: "empresa.nit", align: "right" }),
        block({ kind: "field", y: 90, value: "credit_limit" }),
        block({ kind: "variable", y: 110, value: "no.such.variable" }),
        block({ kind: "page_number", y: 800 }),
      ]),
      vars,
      undefined,
      undefined,
      { pageText: "Página {n} de {total}" },
    );
    expect(Buffer.from(pdf.subarray(0, 4)).toString("latin1")).toBe("%PDF");
    const text = pdfText(pdf);
    expect(text).toContain("Certificado de cliente");
    expect(text).toContain("900373115-3");
    expect(text).toContain("$ 1.234.567,00");
    expect(text).toContain("Página 1 de 1");
    const [w, h] = mediaBox(pdf);
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);
  });

  it("the page number's words come from the caller (packages/i18n); without them only the numbers print", async () => {
    const page = template([block({ kind: "page_number", y: 800 })]);
    expect(pdfText(await renderTemplatePdf(page, {}, undefined, undefined, { pageText: "Page {n} of {total}" }))).toContain("Page 1 of 1");
    const bare = pdfText(await renderTemplatePdf(page, {}));
    expect(bare).toContain("1 / 1");
    expect(bare).not.toContain("Página");
  });

  it("a lines block prints the rows with their headers and the money total, page after page; a list is A4 landscape", async () => {
    const columns = exportColumns(client, open, { columns: ["name", "credit_limit"] }, { labels });
    const rows = Array.from({ length: 120 }, (_, i) => ({ name: `Cliente ${i + 1}`, credit_limit: "1000.0000" }));
    const pdf = await renderTemplatePdf(
      template([block({ kind: "lines", y: 80, w: 700 }), block({ kind: "page_number", y: 560, value: "Hoja {n} de {total}" })], "list"),
      listVariables(ctxFor(open), client, rows),
      { columns, rows },
    );
    expect(pageCount(pdf)).toBeGreaterThan(2);
    const text = pdfText(pdf);
    expect(text).toContain("Cupo de crédito");
    expect(text).toContain("Cliente 1");
    expect(text).toContain("Cliente 120");
    expect(text).toContain("$ 120.000,00");
    expect(text).toContain(`Hoja ${pageCount(pdf)} de ${pageCount(pdf)}`);
    const [w] = mediaBox(pdf);
    expect(Math.round(w)).toBe(842);
  });

  it("a lines block prints only the columns it names, and a masked column empty", async () => {
    const columns = exportColumns(client, access, { columns: ["name", "credit_limit", "tax_id"] }, { labels });
    const pdf = await renderTemplatePdf(template([block({ kind: "lines", columns: ["name", "credit_limit"] })], "list"), {}, { columns, rows: [record] });
    const text = pdfText(pdf);
    expect(text).toContain("Tienda La Esquina");
    expect(text).not.toContain("800123456");
    expect(text).not.toContain(MASK);
    expect(text).not.toContain("1.234.567");
  });

  it("an image block prints the image of its variable (a data URI) and nothing when it is empty", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const withLogo = await renderTemplatePdf(template([block({ kind: "image", w: 60, h: 30, value: "empresa.logo" })]), { "empresa.logo": png });
    expect(Buffer.from(withLogo).toString("latin1")).toContain("/Subtype /Image");
    const without = await renderTemplatePdf(template([block({ kind: "image", w: 60, h: 30, value: "empresa.logo" })]), { "empresa.logo": "" });
    expect(Buffer.from(without).toString("latin1")).not.toContain("/Subtype /Image");
  });

  it("with a fixed print instant the same template and data render byte for byte the same PDF, with or without a background (Task 12: a retried state e-mail sends the identical body)", async () => {
    const bg = await PDFDocument.create();
    bg.addPage([612, 792]).drawText("MEMBRETE", { x: 40, y: 750, size: 12, font: await bg.embedFont(StandardFonts.Helvetica) });
    const background = await bg.save();
    const printedAt = new Date("2026-11-02T15:04:05Z");
    const t = template([block({ kind: "text", y: 60, value: "Café del Norte" }), block({ kind: "page_number", y: 700 })]);
    const once = await renderTemplatePdf(t, {}, undefined, undefined, { printedAt });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(Buffer.compare(once, await renderTemplatePdf(t, {}, undefined, undefined, { printedAt }))).toBe(0);
    const layered = await renderTemplatePdf(t, {}, undefined, background, { printedAt });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(Buffer.compare(layered, await renderTemplatePdf(t, {}, undefined, background, { printedAt }))).toBe(0);
  });

  it("draws the blocks over the background PDF's first page, and its second page under the continuation pages, at its size", async () => {
    const bg = await PDFDocument.create();
    const font = await bg.embedFont(StandardFonts.Helvetica);
    bg.addPage([612, 792]).drawText("MEMBRETE PRIMERA", { x: 40, y: 750, size: 12, font });
    bg.addPage([612, 792]).drawText("MEMBRETE CONTINUA", { x: 40, y: 750, size: 12, font });
    const background = await bg.save();

    const columns = exportColumns(client, open, { columns: ["name"] }, { labels });
    const rows = Array.from({ length: 80 }, (_, i) => ({ name: `Fila ${i + 1}` }));
    const pdf = await renderTemplatePdf(template([block({ kind: "text", y: 60, value: "Encima del fondo" }), block({ kind: "lines", y: 100 })]), {}, { columns, rows }, background);
    const text = pdfText(pdf);
    expect(text).toContain("MEMBRETE PRIMERA");
    expect(text).toContain("MEMBRETE CONTINUA");
    expect(text).toContain("Encima del fondo");
    expect(text).toContain("Fila 80");
    expect(pageCount(pdf)).toBeGreaterThan(1);
    const [w, h] = mediaBox(pdf);
    expect([Math.round(w), Math.round(h)]).toEqual([612, 792]);
  });

  it("refuses a background that is not a PDF", async () => {
    await expect(renderTemplatePdf(template([block({ kind: "text", value: "x" })]), {}, undefined, new TextEncoder().encode("no soy un pdf"))).rejects.toThrow();
  });
});

describe("logo bytes", () => {
  it("a PNG or JPEG is recognised by its first bytes, whatever its stored type says", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(imageBytesMatch(png, "image/png")).toBe(true);
    expect(imageBytesMatch(jpeg, "image/jpeg")).toBe(true);
    expect(imageBytesMatch(jpeg, "image/png")).toBe(false);
    expect(imageBytesMatch(Buffer.from("not a png"), "image/png")).toBe(false);
    expect(imageBytesMatch(png, "application/pdf")).toBe(false);
  });
});
