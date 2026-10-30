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
    expect(recordEntity("accounting.account")).toMatchObject({ consult: "accounting.account.consult", create: "accounting.account.create", update: "accounting.account.update", titleField: "code" });
    expect(recordEntity("accounting.journal")).toMatchObject({ consult: "accounting.journal.consult", create: "accounting.journal.create", update: "accounting.journal.update" });
    expect(recordEntity("accounting.posting_rule")).toMatchObject({ consult: "accounting.posting_rule.consult", update: "accounting.posting_rule.update", titleField: "name" });
    expect(NEW_RECORD_ID).toBe("new");
  });

  it("the accounting masters are record pages: the four analytic nodes, Fuente, Plantilla, Período and Regla contable; the ones created elsewhere have no create form", () => {
    for (const node of ["cost_center", "open_auxiliary", "item", "business_unit"]) {
      expect(recordEntity(`accounting.${node}`)).toMatchObject({ consult: `accounting.${node}.consult`, create: `accounting.${node}.create`, update: `accounting.${node}.update` });
    }
    for (const id of ["accounting.entry_template", "accounting.period", "accounting.posting_rule"]) expect(recordEntity(id)?.create).toBe("");
    expect(recordEntity("accounting.period")?.update).toBe("");
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
