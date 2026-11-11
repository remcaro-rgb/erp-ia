import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, recordPageEntities, Registry } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { inventory } from "@erp/module-inventory";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";
import { warehouse } from "@erp/module-warehouse";
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

  it("the inventory and costing records open here: the maestros save by create and update, the documentos only by the process that creates them (plan 2B Task 10)", () => {
    expect(recordEntity("inventory.warehouse")).toMatchObject({ consult: "inventory.warehouse.consult", create: "inventory.warehouse.create", update: "inventory.warehouse.update", titleField: "name" });
    expect(recordEntity("inventory.location")).toMatchObject({ consult: "inventory.location.consult", create: "inventory.location.create", update: "inventory.location.update" });
    expect(recordEntity("inventory.movement")).toMatchObject({ consult: "inventory.movement.consult", create: "inventory.movement.post", update: "", titleField: "number" });
    expect(recordEntity("inventory.transfer")).toMatchObject({ create: "inventory.transfer.create", update: "" });
    expect(recordEntity("inventory.count")).toMatchObject({ create: "inventory.count.create", update: "" });
    expect(recordEntity("costing.landed_cost")).toMatchObject({ consult: "costing.landed_cost.consult", create: "costing.landed_cost.allocate", update: "" });
    // Task 28.5: the lote and the serial (maestros, create and update) and the seguimiento por producto, keyed by its product (one process).
    expect(recordEntity("inventory.lot")).toMatchObject({ consult: "inventory.lot.consult", create: "inventory.lot.create", update: "inventory.lot.update", titleField: "code" });
    expect(recordEntity("inventory.serial")).toMatchObject({ consult: "inventory.serial.consult", create: "inventory.serial.create", update: "inventory.serial.update", titleField: "serial_no" });
    expect(recordEntity("inventory.product_tracking")).toMatchObject({
      consult: "inventory.product_tracking.consult", create: "inventory.product_tracking.set", update: "inventory.product_tracking.set", titleField: "product_id",
      keyedBy: { view: "inventory.v_product_tracking", column: "product_id", input: "productId" },
    });
    // Every inventory and costing entity that declares a record page opens here.
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, inventory, costing]);
    for (const id of recordPageEntities(registry.entities())) if (id.startsWith("inventory.") || id.startsWith("costing.")) expect(recordEntity(id)).not.toBeNull();
    expect([...recordPageEntities(registry.entities())].filter((id) => ["inventory.lot", "inventory.serial", "inventory.product_tracking"].includes(id)).sort()).toEqual(["inventory.lot", "inventory.product_tracking", "inventory.serial"]);
  });

  it("the CRM and sales records open here: the maestros and the open documentos save by create and update, the rest only by create (plan 2B Task 14b)", () => {
    expect(recordEntity("crm.lead")).toMatchObject({ consult: "crm.lead.consult", create: "crm.lead.create", update: "crm.lead.update", titleField: "name" });
    expect(recordEntity("crm.pipeline")).toMatchObject({ create: "crm.pipeline.create", update: "crm.pipeline.update" });
    expect(recordEntity("crm.quote")).toMatchObject({ consult: "crm.quote.consult", create: "crm.quote.create", update: "crm.quote.update", titleField: "number" });
    expect(recordEntity("sales.order")).toMatchObject({ create: "sales.order.create", update: "sales.order.update", titleField: "number" });
    for (const id of ["crm.opportunity", "crm.activity", "sales.delivery", "sales.return"]) expect(recordEntity(id)?.update).toBe("");
    // Every CRM and sales entity that declares a record page opens here.
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, inventory, costing, sales, crm]);
    const pages = [...recordPageEntities(registry.entities())].filter((id) => id.startsWith("crm.") || id.startsWith("sales.")).sort();
    // Task 30.4: the commission plan (a maestro saved by its create and update) and the commission (written only by its events).
    expect(pages).toEqual(["crm.activity", "crm.lead", "crm.opportunity", "crm.pipeline", "crm.quote", "sales.commission", "sales.commission_plan", "sales.delivery", "sales.order", "sales.return"]);
    expect(recordEntity("sales.commission_plan")).toMatchObject({ consult: "sales.commission_plan.consult", create: "sales.commission_plan.create", update: "sales.commission_plan.update", titleField: "name" });
    expect(recordEntity("sales.commission")).toMatchObject({ consult: "sales.commission.consult", create: "", update: "", titleField: "number", importable: false });
    for (const id of pages) expect(recordEntity(id)).not.toBeNull();
  });

  it("the invoice and the note open here: an invoice is written by create and update, a note only from its invoice; neither imports (plan 2B Task 20)", () => {
    expect(recordEntity("invoicing.invoice")).toMatchObject({ consult: "invoicing.invoice.consult", create: "invoicing.invoice.create", update: "invoicing.invoice.update", titleField: "number", importable: false });
    expect(recordEntity("invoicing.note")).toMatchObject({ consult: "invoicing.note.consult", create: "", update: "", titleField: "number", importable: false });
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, accounting, inventory, costing, sales, crm, invoicing]);
    const pages = [...recordPageEntities(registry.entities())].filter((id) => id.startsWith("invoicing.")).sort();
    expect(pages).toEqual(["invoicing.invoice", "invoicing.note"]);
    for (const id of pages) expect(recordEntity(id)).not.toBeNull();
  });

  it("the medio de pago and the caja (maestros) and the recibo de caja open here: a receipt is written only by «Registrar pago», never edited nor imported (plan 2B Task 24b)", () => {
    expect(recordEntity("payments.method")).toMatchObject({ consult: "payments.method.consult", create: "payments.method.create", update: "payments.method.update", titleField: "name" });
    expect(recordEntity("payments.cash_box")).toMatchObject({ consult: "payments.cash_box.consult", create: "payments.cash_box.create", update: "payments.cash_box.update", titleField: "name" });
    expect(recordEntity("payments.receipt")).toMatchObject({ consult: "payments.receipt.consult", create: "payments.payment.receive", update: "", titleField: "number", importable: false });
    // An application of an advance (plan 2B.2 Task 36) is written only by «Aplicar a facturas» (payments.advance.apply), never edited nor imported.
    expect(recordEntity("payments.advance_application")).toMatchObject({ consult: "payments.advance_application.consult", create: "payments.advance.apply", update: "", titleField: "number", importable: false });
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, payments]);
    const pages = [...recordPageEntities(registry.entities())].filter((id) => id.startsWith("payments.")).sort();
    expect(pages).toEqual(["payments.advance_application", "payments.cash_box", "payments.method", "payments.receipt"]);
    for (const id of pages) expect(recordEntity(id)).not.toBeNull();
  });

  it("the alistamiento and the empaque open here, each created from its source and moved only by its steps (plan 2B.2 Task 29.4)", () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, inventory, costing, warehouse]);
    expect([...recordPageEntities(registry.entities())].filter((id) => id.startsWith("warehouse.")).sort()).toEqual(["warehouse.pack", "warehouse.pick"]);
    // An alistamiento is made from its pedido (the «Alistamientos» tab, the event), an empaque from its alistamiento: no form of their own.
    expect(recordEntity("warehouse.pick")).toMatchObject({ consult: "warehouse.pick.consult", create: "", update: "", titleField: "number", importable: false });
    expect(recordEntity("warehouse.pack")).toMatchObject({ consult: "warehouse.pack.consult", create: "", update: "", titleField: "number", importable: false });
    // The lines, the Parámetros and the reglas de ubicación (a parámetro edited on its own page) have no record page.
    for (const id of ["warehouse.pick_line", "warehouse.pack_package", "warehouse.settings", "warehouse.putaway_rule"]) expect(recordEntity(id)).toBeNull();
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
