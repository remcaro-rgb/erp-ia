import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { buildTemplate, importColumns, importLines, parseImportBook } from "@erp/kernel/import";
import { core } from "@erp/module-core";
import { accounting } from "../index";

// A comprobante imports as a documento (entity types spec §2.5, D14; Task 13 fix round 1, C1): the Datos sheet holds its header, the
// Líneas sheet its lines, joined by `ref`. The lines are found from the entity's `typed.lines` declaration (accounting.entry_line), never
// from Datos adicionales libres (`extraFree`), which is also an array of objects in the create input.

const registry = () => {
  const r = new Registry();
  loadModules(r, [kernelModule, core, accounting]);
  return r;
};

describe("comprobante import layout (C1)", () => {
  it("the header leads with ref and has no lines column; the lines are accounting.entry_line's, keyed by the create input's `lines`", () => {
    const r = registry();
    const header = importColumns(r, "accounting.entry").map((c) => c.key);
    expect(header[0]).toBe("ref");
    expect(header).toEqual(expect.arrayContaining(["date", "description"]));
    expect(header).not.toContain("lines");
    expect(header).not.toContain("extraFree");
    const lines = importLines(r, "accounting.entry");
    expect(lines).toMatchObject({ key: "lines", entity: "accounting.entry_line" });
    expect(lines!.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["ref", "accountId", "accountCode", "debit", "credit", "description"]));
  });

  it("the Excel template has the Datos and Líneas sheets, both with ref", async () => {
    const template = await buildTemplate(registry(), "accounting.entry", "xlsx");
    const book = await parseImportBook(template.bytes, template.fileName);
    expect(book.header.headers[0]).toBe("ref");
    expect(book.lines?.headers).toEqual(expect.arrayContaining(["ref", "accountCode", "debit", "credit"]));
  });
});
