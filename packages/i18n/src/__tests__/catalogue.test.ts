import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry, type ProcessErrorCode } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing, FIFO_PHASE_3 } from "@erp/module-costing";
import { invoicing } from "@erp/module-invoicing";
import { payments, PAYMENTS_REFUSAL_CODES } from "@erp/module-payments";
import { crm } from "@erp/module-crm";
import { sales } from "@erp/module-sales";
import { inventory } from "@erp/module-inventory";
import { support } from "@erp/module-support";
import { z } from "zod";
import { collectRegistryKeys, defaultLocale, locales, messages, translate, type Messages } from "../index";

/** Every leaf of a nested catalogue as `a.b.c`, sorted. */
function leaves(tree: Messages, prefix = ""): string[] {
  return Object.entries(tree)
    .flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`)))
    .sort();
}

function valueAt(tree: Messages, key: string): string | undefined {
  let node: Messages | string | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** ICU arguments a message uses: `{name}` and `{count, plural, ...}` both give the name. */
const argumentsOf = (text: string): string[] => [...new Set([...text.matchAll(/\{\s*([a-z_][a-z0-9_]*)\s*[,}]/g)].map((m) => m[1]!))].sort();

const registry = new Registry();
loadModules(registry, [kernelModule, core, support, accounting, inventory, costing, sales, crm, invoicing, payments]);

const es = messages("es-419");
const en = messages("en");

describe("locales", () => {
  it("offers es-419 first and defaults to it", () => {
    expect(locales).toEqual(["es-419", "en"]);
    expect(defaultLocale).toBe("es-419");
  });

  it("has the namespaces of the design in every catalogue", () => {
    const namespaces = ["accounting", "agent", "auth", "common", "costing", "crm", "entity", "errors", "feature", "field", "grid", "home", "inventory", "invoicing", "nav", "payments", "process", "report", "sales"];
    expect(Object.keys(es).sort()).toEqual(namespaces);
    expect(Object.keys(en).sort()).toEqual(namespaces);
  });
});

describe("catalogue shape", () => {
  it("en has exactly the keys of es-419", () => {
    expect(leaves(en)).toEqual(leaves(es));
  });

  it("no value is empty, in either locale", () => {
    for (const [name, tree] of [["es-419", es], ["en", en]] as const) {
      const empty = leaves(tree).filter((key) => (valueAt(tree, key) ?? "").trim() === "");
      expect(empty, `${name} has empty values`).toEqual([]);
    }
  });

  it("every key is lowercase snake_case segments joined by dots", () => {
    const bad = leaves(es).filter((key) => !/^[a-z0-9_.]+$/.test(key) || key.split(".").some((part) => part === ""));
    expect(bad).toEqual([]);
  });

  it("a message uses the same arguments in both locales", () => {
    const mismatched = leaves(es).filter((key) => argumentsOf(valueAt(es, key)!).join() !== argumentsOf(valueAt(en, key)!).join());
    expect(mismatched).toEqual([]);
  });
});

/** The accounting cards keep short catalogue keys (`home.kpi.accounting_*`) that differ from their provider ids. */
const KPI_CARD_KEY: Record<string, string> = {
  "accounting.result_month": "accounting_result",
  "accounting.pending_failures": "accounting_pending",
  "accounting.open_periods": "accounting_periods",
  "accounting.draft_entries": "accounting_drafts",
  "accounting.income_month": "accounting_income",
  "accounting.expenses_month": "accounting_expenses",
  "accounting.margin_month": "accounting_margin",
  "accounting.posted_entries": "accounting_posted",
  "core.new_parties_month": "core_new_parties",
  "support.resolved_30d": "support_resolved",
  "kernel.active_users": "kernel_users",
  "kernel.audit_24h": "kernel_audit",
};

describe("home screen", () => {
  it("has the card texts of every KPI provider the loaded modules register", () => {
    const providers = registry.kpiProviders();
    expect(providers.map((p) => p.id)).toEqual(expect.arrayContaining(["core.parties", "core.products", "support.tickets", "kernel.ai_tokens", ...Object.keys(KPI_CARD_KEY)]));
    for (const locale of [es, en]) {
      for (const provider of providers) {
        const key = KPI_CARD_KEY[provider.id] ?? provider.id.replace(".", "_");
        expect(valueAt(locale, `home.kpi.${key}.label`), provider.id).toBeTruthy();
      }
    }
  });
});

describe("home charts and the Inicio catalogue", () => {
  it("has the title of every chart provider and the name and description of every KPI and chart provider", () => {
    const providers = [...registry.kpiProviders(), ...registry.chartProviders()];
    expect(registry.chartProviders().length).toBeGreaterThanOrEqual(10);
    for (const locale of [es, en]) {
      for (const chart of registry.chartProviders()) expect(valueAt(locale, `home.chart.${chart.id.replace(".", "_")}.label`), chart.id).toBeTruthy();
      for (const provider of providers) {
        const base = `home.catalog.${provider.id.replace(/\./g, "_")}`;
        expect(valueAt(locale, `${base}.label`), provider.id).toBeTruthy();
        expect(valueAt(locale, `${base}.description`), provider.id).toBeTruthy();
      }
    }
  });
});

describe("registry labels", () => {
  const keys = collectRegistryKeys(registry);

  it("collects the entity, field, navigation and feature labels of the loaded modules", () => {
    expect(keys).toContain("entity.core.party");
    expect(keys).toContain("field.core.party.legal_name");
    expect(keys).toContain("nav.core.parties");
    expect(keys).toContain("feature.kernel.attachments");
    expect(keys).toContain("nav.support.tickets");
    expect(keys).toContain("field.support.ticket.context");
    expect(keys.filter((key) => key.startsWith("entity.")).length).toBe(registry.entities().length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every registered label key exists in es-419 and en", () => {
    expect(keys.filter((key) => valueAt(es, key) === undefined)).toEqual([]);
    expect(keys.filter((key) => valueAt(en, key) === undefined)).toEqual([]);
  });

  it("every registered label key lives in its own namespace", () => {
    for (const key of keys) expect(["entity", "field", "nav", "feature"]).toContain(key.split(".")[0]);
  });
});

describe("process errors", () => {
  const codes: Record<ProcessErrorCode, true> = {
    not_entitled: true,
    forbidden: true,
    step_up_required: true,
    invalid_input: true,
    not_found: true,
    handler_failed: true,
    idempotent_replay: true,
    invalid_state: true,
    stale_record: true,
    maestro_not_usable: true,
    record_forbidden: true,
  };

  it("every ProcessError code has an errors.<code> message in both locales", () => {
    for (const code of Object.keys(codes)) {
      expect(valueAt(es, `errors.${code}`), `es-419 errors.${code}`).toBeTruthy();
      expect(valueAt(en, `errors.${code}`), `en errors.${code}`).toBeTruthy();
    }
  });
});

// The accounting catalogue (Task 30, rule 24). The statuses, origins, close checks and refusal codes live where their entity
// fields point (`grid.values.*`), the entry screens under `accounting.entry.*`, the reports under `report.*`: one place for each,
// es-419 and en alike.
describe("accounting catalogue", () => {
  const both = (key: string) => [
    [`es-419 ${key}`, valueAt(es, key)] as const,
    [`en ${key}`, valueAt(en, key)] as const,
  ];
  const missing = (keys: string[]) => keys.flatMap(both).filter(([, value]) => value === undefined).map(([name]) => name);
  const accountingReports = registry.modules().filter((m) => m.id === "accounting").flatMap((m) => m.reports ?? []);

  it("labels the twenty accounting entities and the journal master as Fuente / Fuentes", () => {
    const entities = registry.entities().filter((e) => e.module === "accounting");
    expect(entities).toHaveLength(20);
    expect(missing(entities.map((e) => e.label))).toEqual([]);
    expect(valueAt(es, "entity.accounting.journal")).toBe("Fuente");
    expect(valueAt(es, "nav.accounting.journals")).toBe("Fuentes");
    expect(valueAt(es, "nav.accounting.reports")).toBeTruthy();
  });

  it("has a label for every field of the accounting entities", () => {
    const fields = registry.entities().filter((e) => e.module === "accounting").flatMap((e) => e.fields.map((f) => f.label));
    expect(fields.length).toBeGreaterThan(200);
    expect(missing(fields)).toEqual([]);
  });

  it("has a label for every value of every enum field that names a catalogue (statuses, origins, kinds, failure codes)", () => {
    const keys = registry
      .entities()
      .filter((e) => e.module === "accounting")
      .flatMap((e) => e.fields.filter((f) => f.type === "enum" && f.valuesKey).flatMap((f) => f.enumValues!.map((v) => `${f.valuesKey}.${v}`)));
    expect(keys).toEqual(expect.arrayContaining(["accounting.values.entry_status.pending", "accounting.values.entry_origin.template", "accounting.values.failure_code.no_journal"]));
    expect(missing(keys)).toEqual([]);
  });

  it("has the five statuses, the four origins, the ten close checks and the refusal codes of the validation", () => {
    const keys = [
      ...["draft", "saved", "pending", "rejected", "approved", "posted", "reversed", "voided"].map((v) => `accounting.values.entry_status.${v}`),
      ...["manual", "auto", "import", "template"].map((v) => `accounting.values.entry_origin.${v}`),
      ...["drafts", "pending_approvals", "pending_failures", "undispatched_events", "control_receivable", "control_payable", "control_inventory", "suspense_zero", "rounding_within_tolerance", "contra_nature_balances"].map((v) => `accounting.values.close_check.${v}`),
      ...["unbalanced", "missing_account_mapping", "closed_period", "inactive_account", "missing_party", "missing_cost_center", "missing_open_auxiliary", "missing_item", "missing_business_unit", "inactive_dimension", "invalid_template", "no_journal", "account_forbidden", "same_user_approval", "manual_journal_only"].map((v) => `accounting.values.failure_code.${v}`),
    ];
    expect(missing(keys)).toEqual([]);
  });

  it("has the title, the columns and the parameters of the thirteen reports", () => {
    expect(accountingReports).toHaveLength(13);
    const keys: string[] = ["report.restricted_accounts", "report.omitted_lines", "grid.sort.max_levels", "grid.group.group_by", "grid.group.no_value"];
    for (const report of accountingReports) {
      keys.push(report.label, ...report.columns.map((c) => c.label));
      const props = Object.keys((z.toJSONSchema(report.params, { io: "input", unrepresentable: "any" }) as { properties?: object }).properties ?? {});
      for (const name of props) {
        const snake = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        const own = `report.param.${report.id}.${snake}`;
        const shared = `report.param.${snake}`;
        expect(valueAt(es, own) ?? valueAt(es, shared), `${report.id} parameter ${name}`).toBeTruthy();
        expect(valueAt(en, own) ?? valueAt(en, shared), `${report.id} parameter ${name} (en)`).toBeTruthy();
      }
    }
    expect(missing(keys)).toEqual([]);
  });

  it("has the home cards and the entry screen texts", () => {
    const keys = ["accounting_result", "accounting_pending", "accounting_periods", "accounting_drafts"].flatMap((k) => [`home.kpi.${k}.label`, `home.kpi.${k}.detail`]);
    expect(missing(keys)).toEqual([]);
    expect(missing(["common.record.actions.submit", "common.record.actions.approve", "accounting.entry.balanced", "accounting.entry.unbalanced", "accounting.entry.keyboard_hint"])).toEqual([]);
  });
});

describe("translate (the catalogue the kernel prints with, registerCatalogue)", () => {
  it("gives the message at a dotted key in the locale, the default locale for an unknown one, nothing for a missing key", () => {
    expect(translate("es-419", "common.print.page_number")).toBe("Página {n} de {total}");
    expect(translate("en", "common.print.page_number")).toBe("Page {n} of {total}");
    expect(translate("fr", "common.yes")).toBe(translate("es-419", "common.yes"));
    expect(translate("en", "common.print")).toBeUndefined();
    expect(translate("en", "no.such.key")).toBeUndefined();
  });
});

describe("costing catalogue", () => {
  it("has the refusal of FIFO the settings process prints (disponible en la fase 3), in both locales", () => {
    expect(valueAt(es, "costing.errors.fifo_phase_3")).toBe(FIFO_PHASE_3);
    expect(valueAt(es, "costing.errors.fifo_phase_3")).toContain("disponible en la fase 3");
    expect(valueAt(en, "costing.errors.fifo_phase_3")).toBeDefined();
  });

  it("has the values of the landed cost enums and the notes of its fixed flags", () => {
    for (const tree of [es, en]) {
      for (const basis of ["value", "quantity", "weight"]) expect(valueAt(tree, `costing.values.landed_basis.${basis}`)).toBeDefined();
      for (const role of ["payable", "supplier_advances", "cash", "bank", "suspense"]) expect(valueAt(tree, `costing.values.offset_role.${role}`)).toBeDefined();
      expect(valueAt(tree, "costing.values.event_kind.landed_cost")).toBeDefined();
      expect(valueAt(tree, "costing.values.cost_source.landed_cost")).toBeDefined();
      expect(valueAt(tree, "costing.landed_cost.own_flags.requires_approval")).toBeDefined();
      expect(valueAt(tree, "costing.landed_cost.own_flags.posts")).toBeDefined();
    }
  });
});

describe("crm quotes and sales pricing catalogue (plan 2B Task 12)", () => {
  it("has the quote stages, the notes of its own flags, the refusals and the price sources, in both locales", () => {
    for (const tree of [es, en]) {
      for (const stage of ["open", "sent", "accepted", "expired"]) expect(valueAt(tree, `crm.values.quote_stage.${stage}`)).toBeDefined();
      expect(valueAt(tree, "crm.quote.own_flags.requires_approval")).toBeDefined();
      expect(valueAt(tree, "crm.quote.own_flags.posts")).toBeDefined();
      for (const code of ["quote_pending_approval", "quote_accepted", "quote_expired", "not_invoice_ready"]) expect(valueAt(tree, `crm.errors.${code}`)).toBeDefined();
      for (const source of ["customer_list", "default_list", "list_price"]) expect(valueAt(tree, `sales.values.price_source.${source}`)).toBeDefined();
      expect(valueAt(tree, "nav.modules.sales")).toBeDefined();
    }
    expect(valueAt(es, "sales.errors.price_not_found")).toContain("indica el precio unitario");
  });
});

describe("payments catalogue", () => {
  it("names the module, the kinds of medio de pago and the receipt's own flags, in both locales", () => {
    for (const tree of [es, en]) {
      expect(valueAt(tree, "nav.modules.payments")).toBeDefined();
      for (const kind of ["cash", "transfer", "card", "check", "other"]) expect(valueAt(tree, `payments.values.method_kind.${kind}`)).toBeDefined();
      expect(valueAt(tree, "payments.receipt.own_flags.requires_approval")).toBeDefined();
      expect(valueAt(tree, "payments.receipt.own_flags.posts")).toBeDefined();
      for (const code of PAYMENTS_REFUSAL_CODES) expect(valueAt(tree, `payments.errors.${code}`), code).toBeDefined();
    }
    expect(valueAt(es, "nav.modules.payments")).toBe("Pagos");
  });
});

describe("invoicing catalogue", () => {
  it("names every value the invoicing fields take and the invoice's own flags, in both locales", () => {
    // The side menu, the module Inicio, the permission matrix and Módulos name a module by nav.modules.<id> (Task 27: Facturación had none).
    expect(valueAt(es, "nav.modules.invoicing")).toBe("Facturación");
    expect(valueAt(en, "nav.modules.invoicing")).toBe("Invoicing");
    for (const tree of [es, en]) {
      for (const mode of ["manual", "on_delivery", "on_order_confirmation"]) expect(valueAt(tree, `invoicing.values.invoice_creation.${mode}`)).toBeDefined();
      for (const env of ["habilitacion", "produccion"]) expect(valueAt(tree, `invoicing.values.dian_environment.${env}`)).toBeDefined();
      for (const stage of ["draft", "issued", "paid", "voided"]) expect(valueAt(tree, `invoicing.values.stage.${stage}`)).toBeDefined();
      for (const status of ["draft", "submitted", "accepted", "rejected"]) expect(valueAt(tree, `invoicing.values.dian_status.${status}`)).toBeDefined();
      for (const origin of ["manual", "from_orders", "on_delivery", "on_order_confirmation"]) expect(valueAt(tree, `invoicing.values.origin.${origin}`)).toBeDefined();
      for (const form of ["1", "2"]) expect(valueAt(tree, `invoicing.values.payment_form.${form}`)).toBeDefined();
      for (const status of ["open", "resolved"]) expect(valueAt(tree, `invoicing.values.recommendation_status.${status}`)).toBeDefined();
      // The DIAN submission (Task 17): its statuses and the reasons the invoice page shows.
      for (const status of ["queued", "not_configured", "processing", "submitted", "accepted", "rejected", "failed"]) expect(valueAt(tree, `invoicing.values.submission_status.${status}`)).toBeDefined();
      for (const code of ["einvoice_accepted", "einvoice_in_progress", "einvoice_not_configured", "einvoice_not_awaiting", "invoice_not_issued", "poll_limit", "cufe_changed", "document_changed", "currency_not_supported", "submission_in_doubt", "credentials_missing"]) expect(valueAt(tree, `invoicing.errors.${code}`)).toBeDefined();
      expect(valueAt(tree, "invoicing.invoice.own_flags.requires_approval")).toBeDefined();
      expect(valueAt(tree, "invoicing.invoice.own_flags.posts")).toBeDefined();
      // Task 18: the notes' kinds and stages, their own flags and the refusals of a note or an annulment.
      for (const kind of ["credit", "debit"]) expect(valueAt(tree, `invoicing.values.note_kind.${kind}`)).toBeDefined();
      for (const stage of ["draft", "issued"]) expect(valueAt(tree, `invoicing.values.note_stage.${stage}`)).toBeDefined();
      expect(valueAt(tree, "invoicing.note.own_flags.requires_approval")).toBeDefined();
      expect(valueAt(tree, "invoicing.note.own_flags.posts")).toBeDefined();
      for (const code of ["invoice_rejected", "invoice_not_sent", "invoice_send_failed", "invoice_not_accepted", "invoice_voided", "invoice_has_note", "note_references_note", "credit_exceeds_invoice", "invalid_note_line", "invalid_note_concept", "annulment_by_void", "note_not_voidable", "note_not_issued", "cude_changed", "nothing_to_note", "note_draft_delete", "note_issued", "note_not_sent", "annulment_invoice_not_issued", "no_sequence"]) expect(valueAt(tree, `invoicing.errors.${code}`)).toBeDefined();
    }
  });
});

describe("DIAN checklist copy (plan 2B Task 35, R35-3)", () => {
  const groups = ["notes_documents", "signing_software", "dian_response", "taxes_amounts", "payment_buyers", "issuer_profile", "infrastructure", "reference_tables"];
  it("has the screen's texts, the eight group headings, the refusals and the processes' names, in both locales with the same arguments", () => {
    const keys = [
      "title", "subtitle", "back", "admins_only", "progress", "progress_label", "list_label", "group_select", "group_clear", "verified_by", "verified_on", "new_badge", "doc_link",
      "mark_selected", "save_changes", "pending_changes", "saved", "saved_cleared", "locked_in_production", "confirm_button", "confirm_incomplete", "confirm_save_first",
      "confirmed_on", "confirmed_on_unknown", "confirmed", "not_confirmed", "alert_new", "alert_new_hint", ...groups.map((g) => `groups.${g}`),
    ].map((k) => `invoicing.dian_checklist.${k}`);
    const more = [
      "invoicing.settings_page.dian_defaults_progress", "invoicing.settings_page.dian_defaults_confirmed_status", "invoicing.settings_page.dian_defaults_new", "invoicing.settings_page.open_checklist",
      "invoicing.errors.dian_checklist_incomplete", "invoicing.errors.dian_in_production", "invoicing.errors.dian_defaults_unconfirmed",
      "process.invoicing.dian_checklist.tick", "process.invoicing.dian_checklist.consult", "process.invoicing.dian_defaults.confirm",
      "entity.invoicing.dian_check", "field.invoicing.settings.dian_checklist_version", "field.invoicing.dian_check.ticked_by",
    ];
    for (const key of [...keys, ...more]) {
      expect(valueAt(es, key), `es-419 ${key}`).toBeDefined();
      expect(valueAt(en, key), `en ${key}`).toBeDefined();
    }
    expect(argumentsOf(valueAt(es, "invoicing.dian_checklist.verified_by")!)).toEqual(["date", "name"]);
    expect(argumentsOf(valueAt(es, "invoicing.dian_checklist.progress")!)).toEqual(["done", "total"]);
    expect(valueAt(es, "invoicing.dian_checklist.groups.notes_documents")).toBe("Notas y tipos de documento");
  });

  it("the old checkbox's copy is gone", () => {
    for (const tree of [es, en]) expect(valueAt(tree, "invoicing.settings_page.defaults_confirm")).toBeUndefined();
  });

  it("every process of the invoicing checklist is named (the process kinds' namespace)", () => {
    for (const id of ["invoicing.dian_checklist.tick", "invoicing.dian_checklist.consult", "invoicing.dian_defaults.confirm"]) {
      expect(registry.process(id)).toBeDefined();
      expect(valueAt(es, `process.${id}`), id).toBeTruthy();
    }
  });
});

describe("recommendation copy (plan 2B Task 38)", () => {
  it("names the texts and reasons the processes raise, the card's link and the bell, in both locales with the same arguments", () => {
    const reasons = ["invalid_party", "invalid_product", "over_invoicing", "order_cancelled", "order_not_confirmed", "delivery_voided", "delivery_not_shipped", "invalid_order_line", "price_not_found", "invalid_payment_means", "exchange_rate_required", "nothing_to_invoice", "einvoice_not_available", "refused"];
    for (const tree of [es, en]) {
      expect(argumentsOf(valueAt(tree, "invoicing.recommendation.auto_skipped.body")!)).toEqual(["document", "reason"]);
      expect(valueAt(tree, "invoicing.recommendation.auto_skipped.title")).toBeDefined();
      for (const reason of reasons) expect(valueAt(tree, `invoicing.recommendation.reason.${reason}`), reason).toBeDefined();
      expect(argumentsOf(valueAt(tree, "costing.recommendation.cost_missing.body")!)).toEqual(["count", "product", "warehouse"]);
      expect(valueAt(tree, "costing.recommendation.cost_missing.title")).toBeDefined();
      for (const key of ["home.recommendations.open_record", "home.recommendations.no_link", "home.recommendations.agents.process", "home.module.pending", "nav.shell.notifications_more"]) expect(valueAt(tree, key), key).toBeDefined();
    }
    expect(valueAt(es, "invoicing.recommendation.auto_skipped.title")).toBe("No se creó la factura automática");
    expect(valueAt(es, "costing.recommendation.cost_missing.title")).toBe("Falta el costo de un producto");
    expect(valueAt(es, "home.module.pending")).toBe("Pendientes");
  });
});

describe("order owner isolation copy (plan 2B Task 39)", () => {
  it("names the reassign process, the dialog, the facts and the refusal in both locales", () => {
    expect(registry.process("sales.order.reassign")).toBeDefined();
    const keys = [
      "process.sales.order.reassign", "sales.errors.invalid_owner", "sales.view.reassign", "sales.view.reassign_hint", "sales.view.reassign_owner", "sales.view.reassign_pick",
      "sales.view.reassign_cancel", "sales.view.reassign_submit", "sales.view.reassigned", "sales.view.reassigned_unknown", "sales.view.handed_over", "sales.view.handed_over_unknown", "sales.view.order_unavailable",
      "sales.view.no_owner", "invoicing.view.order_unavailable", "invoicing.view.order_owner", "field.sales.order.owner_id", "field.sales.delivery.order_owner_id",
    ];
    for (const tree of [es, en]) for (const key of keys) expect(valueAt(tree, key), key).toBeTruthy();
    expect(argumentsOf(valueAt(es, "sales.view.handed_over")!)).toEqual(["owner"]);
    expect(argumentsOf(valueAt(en, "sales.view.handed_over")!)).toEqual(["owner"]);
    expect(argumentsOf(valueAt(es, "sales.view.reassigned")!)).toEqual(["owner"]);
    expect(valueAt(es, "sales.view.reassign")).toBe("Cambiar vendedor");
    expect(valueAt(es, "sales.view.reassign_hint")).not.toMatch(/\bél\b/);
    expect(valueAt(es, "sales.view.order_unavailable")).toBe("Pedido no disponible");
    expect(valueAt(es, "sales.view.handed_over")).toBe("Pedido creado, asignado a {owner}");
    expect(valueAt(es, "field.sales.order.owner_id")).toBe("Vendedor");
    expect(valueAt(es, "field.sales.delivery.order_owner_id")).toBe("Vendedor del pedido");
    expect(valueAt(es, "sales.errors.invalid_owner")).toBe("El vendedor no pertenece a la empresa");
  });
});
