import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineEntity, kernelModule, loadModules, maskedViewSql, menuItemsOf, Registry, uncoveredMenuProcesses, uncoveredRecordWrites } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import accountingInvoiceIssued from "../../../accounting/src/rules/defaults/invoice-issued.json" with { type: "json" };
import accountingNoteAnnulment from "../../../accounting/src/rules/defaults/note-annulment-issued.json" with { type: "json" };
import accountingNoteCredit from "../../../accounting/src/rules/defaults/note-credit-issued.json" with { type: "json" };
import accountingNoteDebit from "../../../accounting/src/rules/defaults/note-debit-issued.json" with { type: "json" };
import { invoicing, INVOICING_ENTITIES, INVOICING_POSTING_RULES } from "../index";

// The invoicing manifest (plan 2B Task 16, design §8): the invoice (a documento that posts, numbered on «Emitir»), its lines, taxes and
// recommendations, the settings (OD-2), the consumers of sales' events, the rule it ships, and the masked views of migration 0092
// generated from the entity definitions (rule 14).

const migrationFile = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
// 0092 creates the views; 0094 recreates invoicing.v_invoices with service_date (fix round 1); 0095 recreates invoicing.v_settings with the
// DIAN submission's Parámetros and creates invoicing.v_einvoice_submissions (Task 17); 0096 creates the notes' views and recreates
// v_invoices (debited_amount) and v_einvoice_submissions (note_id) (Task 18); 0135 (Task 35) recreates v_settings with
// dian_checklist_version and creates v_dian_checks; 0148 (Task 34.4) recreates the lines' and taxes' views with their company amounts: the latest
// definition of each view must match.
const migration = ["0092_invoicing_core.sql", "0094_invoicing_fix_round_1.sql", "0095_invoicing_einvoice.sql", "0096_invoicing_notes.sql", "0101_invoicing_parametros.sql", "0103_invoicing_certificate_fingerprint.sql", "0107_invoicing_pending_lines.sql", "0121_invoicing_price_date.sql", "0135_invoicing_dian_checklist.sql", "0148_invoicing_company_amounts.sql"].map(migrationFile).join("\n");

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, invoicing]);
  return registry;
};

describe("invoicing manifest", () => {
  it("depends on core only, declares the four menu sections and its features, emits its events and consumes sales' shipped and confirmed", () => {
    expect(invoicing.id).toBe("invoicing");
    expect(invoicing.dependsOn).toEqual(["core"]);
    expect(invoicing.navigation.map((n) => n.id)).toEqual(["invoicing.maestros", "invoicing.documentos", "invoicing.reportes", "invoicing.parametros"]);
    expect(invoicing.features.map((f) => f.id)).toEqual(["invoicing.invoices", "invoicing.settings"]);
    expect(invoicing.features.flatMap((f) => f.entities).sort()).toEqual(INVOICING_ENTITIES.map((e) => e.id).sort());
    expect(invoicing.events.emits).toEqual([
      "invoicing.invoice.created", "invoicing.invoice.issued", "invoicing.invoice.accepted", "invoicing.invoice.rejected", "invoicing.invoice.resubmit_requested",
      // Task 18: the notes, their verdict and the invoice voided by its accepted annulment note (never invoicing.invoice.voided).
      "invoicing.note.issued", "invoicing.note.accepted", "invoicing.note.rejected", "invoicing.invoice.annulled",
      // Task 23: an invoice the receipts settled in full (the CRM logs the payment on the deal).
      "invoicing.invoice.paid",
    ]);
    expect(invoicing.events.emits).not.toContain("invoicing.invoice.voided");
    // Task 17: its own issued event starts the DIAN submission; «Reintentar envío» resumes it. Task 18: an issued note is sent too.
    expect(Object.keys(invoicing.events.consumes)).toEqual(["sales.delivery.shipped", "sales.order.confirmed", "invoicing.invoice.issued", "invoicing.invoice.resubmit_requested", "invoicing.note.issued",
      // Task 23: the receipts and their voids recompute paid_amount and the paid stage.
      "payments.received", "payments.payment.voided",
      // Task 36: an advance applied to invoices (and undone) settles them like a receipt.
      "payments.advance.applied", "payments.advance.unapplied"]);
  });

  it("types the invoice as a documento numbered on save with its lines, the taxes and recommendations as sistema, the settings as parametro", () => {
    expect(Object.fromEntries(INVOICING_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "invoicing.settings": "parametro",
      "invoicing.invoice": "documento",
      "invoicing.invoice_line": "lines",
      "invoicing.invoice_tax": "sistema",
      "invoicing.invoice_recommendation": "sistema",
      "invoicing.einvoice_submission": "sistema",
      "invoicing.note": "documento",
      "invoicing.note_line": "lines",
      "invoicing.note_tax": "sistema",
      "invoicing.dian_check": "sistema",
    });
    const note = INVOICING_ENTITIES.find((e) => e.id === "invoicing.note")!;
    expect(note.typed).toMatchObject({ numbering: "on_save", lines: { entity: "invoicing.note_line", parentField: "note_id" } });
    expect(note.processIds).toEqual({ create: "invoicing.note.create" });
    const invoice = INVOICING_ENTITIES.find((e) => e.id === "invoicing.invoice")!;
    expect(invoice.typed).toMatchObject({ numbering: "on_save", lines: { entity: "invoicing.invoice_line", parentField: "invoice_id" } });
    expect(invoice.processIds).toEqual({ create: "invoicing.invoice.create" });
    for (const entity of INVOICING_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });

  it("loads with its processes, each in its feature, every one under a menu item or the shared list, every record write guarded", () => {
    const registry = loaded();
    const ids = registry.processes({ module: "invoicing" }).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      "invoicing.invoice.create", "invoicing.invoice.update", "invoicing.invoice.from_orders", "invoicing.invoice.issue", "invoicing.invoice.void",
      "invoicing.invoice.consult", "invoicing.invoice_line.consult", "invoicing.invoice_tax.consult", "invoicing.invoice_recommendation.consult",
      "invoicing.invoice.auto_create", "invoicing.invoice.recommend", "invoicing.settings.update", "invoicing.settings.consult",
      "invoicing.einvoice_submission.request", "invoicing.einvoice_submission.record", "invoicing.einvoice_submission.document",
      "invoicing.einvoice_submission.consult", "invoicing.invoice.dian_result", "invoicing.invoice.resubmit",
      "invoicing.note.create", "invoicing.note.issue", "invoicing.note.issue_annulment", "invoicing.note.void", "invoicing.note.consult", "invoicing.note_line.consult",
      "invoicing.note_tax.consult", "invoicing.note.dian_result", "invoicing.note.resubmit", "invoicing.invoice.resubmit_failed",
      "invoicing.invoice.record_payments",
      // Task 35: the DIAN verification checklist (ticks, the confirmation of the defaults, the consult).
      "invoicing.dian_checklist.tick", "invoicing.dian_defaults.confirm", "invoicing.dian_checklist.consult",
    ]));
    const module = registry.module("invoicing");
    expect(module.features.flatMap((f) => f.processes).sort()).toEqual(module.processes.map((p) => p.id).sort());
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    expect(uncoveredRecordWrites(registry)).toEqual([]);
  });

  it("the typed lifecycle's generic processes are the second paths of the same steps: save (Grabar of a Borrador = «Emitir», same hooks), delete (Eliminar a Borrador); void is the module's own", () => {
    const registry = loaded();
    const generic = registry.processes({ module: "invoicing" }).map((p) => p.id).filter((p) => /^invoicing\.invoice\.(save|submit|approve|reject|delete|void)$/.test(p)).sort();
    expect(generic).toEqual(["invoicing.invoice.approve", "invoicing.invoice.delete", "invoicing.invoice.reject", "invoicing.invoice.save", "invoicing.invoice.submit", "invoicing.invoice.void"]);
    expect(registry.process("invoicing.invoice.save").sensitivity ?? "normal").toBe("normal");
    expect(registry.process("invoicing.invoice.void").description).toMatch(/nota crédito de anulación/);
    // The note: Grabar of a Borrador is «Emitir» (same hooks); Anular is its own and refuses (a DIAN note is corrected by another note).
    const noteGeneric = registry.processes({ module: "invoicing" }).map((p) => p.id).filter((p) => /^invoicing\.note\.(save|submit|approve|reject|delete|void)$/.test(p)).sort();
    expect(noteGeneric).toEqual(["invoicing.note.approve", "invoicing.note.delete", "invoicing.note.reject", "invoicing.note.save", "invoicing.note.submit", "invoicing.note.void"]);
    expect(registry.process("invoicing.note.void").description).toMatch(/no se anula/);
  });

  it("«Emitir» is not step-up; Anular and the Parámetros are; the automatic creation runs only from events", () => {
    const registry = loaded();
    expect(registry.process("invoicing.invoice.issue").sensitivity ?? "normal").toBe("normal");
    expect(registry.process("invoicing.invoice.void").sensitivity).toBe("step-up");
    expect(registry.process("invoicing.settings.update").sensitivity).toBe("step-up");
    // Task 35: ticking the DIAN checklist and confirming its defaults are step-up too; the consult is not.
    expect(registry.process("invoicing.dian_checklist.tick").sensitivity).toBe("step-up");
    expect(registry.process("invoicing.dian_defaults.confirm").sensitivity).toBe("step-up");
    expect(registry.process("invoicing.dian_checklist.consult").sensitivity ?? "normal").toBe("normal");
    expect(registry.process("invoicing.invoice.auto_create").origins).toEqual(["event"]);
    expect(registry.process("invoicing.invoice.recommend").origins).toEqual(["event"]);
    expect(registry.process("invoicing.invoice.record_payments").origins).toEqual(["event"]);
    // Task 17: «Reintentar envío» is a normal process; the verdict and the workflow's own steps run only from events.
    expect(registry.process("invoicing.invoice.resubmit").sensitivity ?? "normal").toBe("normal");
    expect(registry.process("invoicing.invoice.resubmit").origins).toBeUndefined();
    for (const id of ["invoicing.invoice.dian_result", "invoicing.einvoice_submission.request", "invoicing.einvoice_submission.record", "invoicing.einvoice_submission.document"]) {
      expect(registry.process(id).origins).toEqual(["event"]);
    }
    // Task 18: «Emitir» a note and the bulk «Reintentar envío» are normal; the annulment note is NOT step-up and runs only nested in Anular
    // of the invoice (whose step-up covers it); the note's verdict only from events.
    expect(registry.process("invoicing.note.issue").sensitivity ?? "normal").toBe("normal");
    // Task 23: issuing a note recomputes the paid status, so a credit note can make the invoice paid.
    expect(registry.process("invoicing.note.issue").emits).toEqual(["invoicing.note.issued", "invoicing.invoice.paid"]);
    expect(registry.process("invoicing.invoice.resubmit_failed").sensitivity ?? "normal").toBe("normal");
    // Task 37 (R37-4): the bulk sweep is the company admin's only (the guard is in the handler; the description says so); no step-up.
    expect(registry.process("invoicing.invoice.resubmit_failed").description).toMatch(/solo el administrador/i);
    expect(registry.process("invoicing.note.issue_annulment").sensitivity ?? "normal").toBe("normal");
    expect(registry.process("invoicing.note.issue_annulment").nestedOnlyFrom).toEqual(["invoicing.invoice.void"]);
    expect(registry.process("invoicing.note.dian_result").origins).toEqual(["event"]);
  });

  it("menu: Facturas and Notas crédito y débito in Documentos, Por facturar in Reportes, Parámetros de facturación in Parámetros", () => {
    const module = loaded().module("invoicing");
    const rows = menuItemsOf(module).filter((r) => r.href && !r.href.startsWith("/invoicing/parametros/"));
    expect(rows.map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["invoicing.invoices", "invoicing.documentos", "/invoicing/invoices"],
      ["invoicing.notes", "invoicing.documentos", "/invoicing/notes"],
      ["invoicing.pending", "invoicing.reportes", "/invoicing/pending"],
      ["invoicing.settings", "invoicing.parametros", "/invoicing/settings"],
    ]);
    const at = (navKey: string) => rows.find((r) => r.navKey === navKey)!;
    expect(at("invoicing.invoices").processIds).toEqual(expect.arrayContaining(["invoicing.invoice.issue", "invoicing.invoice.void", "invoicing.invoice.create"]));
    expect(at("invoicing.pending").processIds).toEqual(expect.arrayContaining(["invoicing.invoice.from_orders"]));
    // Task 20: the notes' grid reads the notes (their issue runs from the note's page, reached from the invoice or this grid).
    expect(at("invoicing.notes").processIds).toEqual(expect.arrayContaining(["invoicing.note.consult", "invoicing.note.issue", "invoicing.note_line.consult"]));
    // Task 20 fix round 1: Por facturar is the universal grid over the pending lines (rule 20), opened through their list process.
    expect(at("invoicing.pending").processIds).toEqual(expect.arrayContaining(["invoicing.pending_line.list"]));
  });

  it("Por facturar's lines are a read-only query entity with no price (Task 20 fix round 1, rule 20): filterable by pedido", () => {
    const registry = loaded();
    const entity = registry.entity("invoicing.pending_line");
    expect(entity.kind).toBe("query");
    expect(entity.table).toBe("pending_lines");
    const names = entity.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["order_id", "order_number", "delivery_id", "delivery_number", "delivery_date", "party_id", "product_id", "description", "delivered_qty", "invoiced_qty", "pending_qty"]));
    expect(names.some((n) => n.includes("price") || n.includes("discount"))).toBe(false);
    expect(entity.fields.find((f) => f.name === "order_number")?.searchable).toBe(true);
    expect(registry.process("invoicing.pending_line.list").kind).toBe("consult");
  });

  it("ships the invoice-issued rule and the three note rules identical to accounting's defaults (same event and name: the sync never adds them twice), and no invoice-voided", () => {
    expect(INVOICING_POSTING_RULES).toEqual([accountingInvoiceIssued, accountingNoteAnnulment, accountingNoteCredit, accountingNoteDebit]);
    // Task 18 fix round 1: the note's revenue line by its kind (rule-level `when`): the annulment and a debit note mirror the invoice
    // (revenue by category), a partial credit goes to sales returns by its concept.
    const notes = INVOICING_POSTING_RULES.filter((r) => r.event === "invoicing.note.issued");
    expect(notes.map((r) => [r.name, r.template.when, r.template.lines[1]!.role, r.template.lines[1]!.dimension])).toEqual([
      ["Nota crédito de anulación de venta", [{ path: "$.annulment", equals: true }], "revenue", "category:{{categoryId}}"],
      ["Nota crédito de venta", [{ path: "$.kind", equals: "credit" }, { path: "$.annulment", equals: false }], "sales_returns", "note_reason:{{$$.reasonCode}}"],
      ["Nota débito de venta", [{ path: "$.kind", equals: "debit" }], "revenue", "category:{{categoryId}}"],
    ]);
    expect(INVOICING_POSTING_RULES.map((r) => r.event)).not.toContain("invoicing.invoice.voided");
  });
});

describe("invoicing masked views, migrations 0092, 0094, 0095, 0096, 0101, 0103, 0107, 0121, 0135 and 0148", () => {
  // Task 34.4 (FX §10, rule 14): each company amount is shown only where its document twin is (the same field rule masks both), read-only.
  it("lists the company amounts of lines and taxes, each masked with its document twin", () => {
    const twins = { "invoicing.invoice_line": ["subtotal_company", "base"], "invoicing.invoice_tax": ["amount_company", "amount"], "invoicing.note_line": ["subtotal_company", "base"], "invoicing.note_tax": ["amount_company", "amount"] } as const;
    for (const [id, [column, twin]] of Object.entries(twins)) {
      const entity = INVOICING_ENTITIES.find((e) => e.id === id)!;
      const field = entity.fields.find((f) => f.name === column);
      expect(field?.type, `${id}.${column}`).toBe("money");
      expect(field?.sensitivity, `${id}.${column}`).toBe(entity.fields.find((f) => f.name === twin)!.sensitivity);
      const view = maskedViewSql(defineEntity(entity));
      expect(view).toContain(`case when (select kernel.field_visible('${id}', '${column}')) then case when (select kernel.field_visible('${id}', '${twin}')) then "${column}" else null end else null end as "${column}"`);
    }
  });

  for (const entity of INVOICING_ENTITIES) {
    it(`invoicing.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      expect(migration).toContain(maskedViewSql(defineEntity(entity)));
    });
  }
});

describe("invoicing.dian_check (Task 35, R35-5/R35-10)", () => {
  it("is a sistema entity of the settings feature whose view carries the settings' new column", () => {
    const entity = INVOICING_ENTITIES.find((e) => e.id === "invoicing.dian_check")!;
    expect(entity.table).toBe("dian_checks");
    expect(entity.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["item_key", "ticked", "ticked_by", "ticked_at"]));
    expect(invoicing.features.find((f) => f.id === "invoicing.settings")!.entities).toEqual(expect.arrayContaining(["invoicing.settings", "invoicing.dian_check"]));
    expect(INVOICING_ENTITIES.find((e) => e.id === "invoicing.settings")!.fields.map((f) => f.name)).toContain("dian_checklist_version");
    expect(migrationFile("0135_invoicing_dian_checklist.sql")).toContain("create or replace view invoicing.v_settings");
    expect(migrationFile("0135_invoicing_dian_checklist.sql")).toContain("invoicing.v_dian_checks");
  });
});
