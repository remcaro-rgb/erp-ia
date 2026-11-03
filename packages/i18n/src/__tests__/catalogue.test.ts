import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry, type ProcessErrorCode } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
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
loadModules(registry, [kernelModule, core, support, accounting]);

const es = messages("es-419");
const en = messages("en");

describe("locales", () => {
  it("offers es-419 first and defaults to it", () => {
    expect(locales).toEqual(["es-419", "en"]);
    expect(defaultLocale).toBe("es-419");
  });

  it("has the namespaces of the design in every catalogue", () => {
    const namespaces = ["accounting", "agent", "auth", "common", "entity", "errors", "feature", "field", "grid", "home", "nav", "process", "report"];
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
