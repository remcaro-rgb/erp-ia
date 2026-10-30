import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, recordPageEntities, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { NEW_RECORD_ID, recordEntity } from "./entities";

describe("record entities", () => {
  it("knows the entities that open as a full page, how to read them and the processes their form saves through", () => {
    expect(recordEntity("core.party")).toMatchObject({ consult: "core.party.consult", create: "core.party.create", update: "core.party.update", titleField: "legal_name" });
    expect(recordEntity("core.product")).toMatchObject({ consult: "core.product.consult", create: "core.product.create", update: "core.product.update", titleField: "description" });
    expect(recordEntity("core.product_category")).toMatchObject({ consult: "core.category.consult", create: "core.category.create", update: "core.category.update", titleField: "name" });
    expect(recordEntity("accounting.entry")).toMatchObject({ consult: "accounting.entry.consult", create: "accounting.entry.create", update: "accounting.entry.update", titleField: "number" });
    expect(NEW_RECORD_ID).toBe("new");
  });

  it("refuses anything else, including inherited object keys", () => {
    for (const id of ["core.uom", "kernel.attachments", "constructor", "__proto__", ""]) expect(recordEntity(id)).toBeNull();
  });

  it("the entities whose modules declare a record page are exactly those that open here, the ticket's frame and the user's page (rule 21)", () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, support]);
    const pages = [...recordPageEntities(registry.entities())].sort();
    expect(pages).toEqual(["core.party", "core.product", "core.product_category", "kernel.user", "support.ticket"]);
    for (const id of pages) expect(recordEntity(id) !== null || id === "support.ticket" || id === "kernel.user").toBe(true);
  });
});
