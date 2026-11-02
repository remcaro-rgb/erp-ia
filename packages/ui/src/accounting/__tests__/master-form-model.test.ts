import { describe, expect, it } from "vitest";
import { activeSpecs, masterDraft, masterInput, masterMissing } from "../master-form-model";

describe("master form model", () => {
  it("a new Fuente starts general, manual and active; its create input carries the code, an update never does", () => {
    const draft = masterDraft("journal", null);
    expect(draft).toMatchObject({ kind: "general", manualEntries: true, isActive: true, code: "", name: "" });
    expect(masterMissing("journal", draft, true)).toBe(true);
    const ready = { ...draft, code: "NC2", name: "Notas 2" };
    expect(masterMissing("journal", ready, true)).toBe(false);
    expect(masterInput("journal", ready, null)).toEqual({ code: "NC2", name: "Notas 2", kind: "general", manualEntries: true, isActive: true });
    const stored = masterDraft("journal", { code: "NC", name: "Notas", kind: "general", manual_entries: false, is_active: true, next_number: 7 });
    expect(masterInput("journal", stored, "j-1")).toEqual({ id: "j-1", name: "Notas", kind: "general", manualEntries: false, isActive: true });
    expect(stored.nextNumber).toBe("7");
  });

  it("a cuenta's update takes the name, nature, flags and section; the code, level and movement flag are shown and never sent", () => {
    const row = { code: "510506", name: "Sueldos", nature: "debit", statement_section: "", requires_party: false, requires_cost_center: true, requires_open_auxiliary: false, requires_item: false, requires_business_unit: false, is_active: true, level: "subaccount", allows_movement: true };
    const draft = masterDraft("account", row);
    // The code is shown on a stored cuenta but never sent: it does not change.
    expect(activeSpecs("account", false).find((s) => s.key === "code")?.createOnly).toBe(true);
    expect(masterInput("account", { ...draft, name: "Sueldos y salarios" }, "a-1")).toEqual({
      id: "a-1", name: "Sueldos y salarios", nature: "debit", requiresParty: false, requiresInvoiceReady: false, requiresCostCenter: true, requiresOpenAuxiliary: false, requiresItem: false, requiresBusinessUnit: false, isActive: true,
    });
    // The invoice-ready flag (rule 10) is a flag like the others: shown, stored, and sent on every update.
    const ready = masterDraft("account", { ...row, requires_invoice_ready: true });
    expect(ready.requiresInvoiceReady).toBe(true);
    expect(masterInput("account", ready, "a-1")).toMatchObject({ requiresInvoiceReady: true });
    expect(activeSpecs("account", true).find((s) => s.key === "requiresInvoiceReady")?.column).toBe("requires_invoice_ready");
    expect(activeSpecs("account", true).map((s) => s.key)).not.toContain("isActive");
  });

  it("a node's parent is cleared with an empty choice, and a plantilla's empty description is cleared", () => {
    const node = masterDraft("dimension", { code: "ADM", name: "Administración", parent_id: null, kind: "leaf", is_active: true });
    expect(masterInput("dimension", node, "n-1")).toEqual({ id: "n-1", name: "Administración", parentId: null, kind: "leaf", isActive: true });
    expect(masterInput("dimension", { ...node, parentId: "g-1" }, "n-1")).toMatchObject({ parentId: "g-1" });
    const template = masterDraft("template", { name: "Arriendo", journal_id: "j-1", description: null });
    expect(masterInput("template", template, "t-1")).toEqual({ id: "t-1", name: "Arriendo", journalId: "j-1", description: null });
  });

  it("a period is shown, not edited", () => {
    expect(activeSpecs("period", false).every((s) => s.control === "fixed")).toBe(true);
    expect(masterInput("period", masterDraft("period", { number: 10 }), "p-1")).toEqual({ id: "p-1" });
  });

  it("a regla's update takes the header fields as numbers and text; the module that shipped it is shown", () => {
    const row = { event: "invoicing.invoice.issued", name: "Factura", journal_id: "j-1", priority: 50, description: null, is_active: true, module: "invoicing" };
    const draft = masterDraft("rule", row);
    expect(masterInput("rule", draft, "r-1")).toEqual({ id: "r-1", event: "invoicing.invoice.issued", name: "Factura", journalId: "j-1", priority: 50, description: null, isActive: true });
    expect(masterInput("rule", { ...draft, priority: "" }, "r-1")).toMatchObject({ priority: 100 });
    expect(activeSpecs("rule", false).find((s) => s.key === "module")?.control).toBe("fixed");
  });
});
