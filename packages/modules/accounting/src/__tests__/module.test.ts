import { describe, it, expect } from "vitest";
import { defineEntity, loadModules, menuItemsOf, Registry, uncoveredMenuProcesses } from "@erp/kernel";
import { core } from "@erp/module-core";
import { accounting, ACCOUNTING_ENTITIES, DIMENSIONS } from "../index";

describe("accounting manifest", () => {
  it("defineModule accepts the manifest: the four menu sections (Maestros with the six masters), three features, 20 entities", () => {
    expect(accounting.id).toBe("accounting");
    expect(accounting.dependsOn).toEqual(["core"]);
    // Entity types spec §2.4, design §22.23: the level-1 items are Maestros, Documentos, Reportes and Parámetros.
    expect(accounting.navigation.map((n) => [n.id, n.href, n.section, n.children?.map((c) => c.href)])).toEqual([
      ["accounting.maestros", "#", "maestros", ["/accounting/accounts", "/accounting/cost-centers", "/accounting/open-auxiliaries", "/accounting/items", "/accounting/business-units", "/accounting/journals", "/accounting/entry-templates"]],
      ["accounting.documentos", "#", "documentos", ["/accounting/entries"]],
      ["accounting.reportes", "#", "reportes", ["/accounting/movements", "/accounting/reports"]],
      ["accounting.parametros", "#", "parametros", ["/accounting/periods", "/accounting/posting"]],
    ]);
    expect(accounting.features.map((f) => f.id)).toEqual(["accounting.ledger", "accounting.periods", "accounting.posting"]);
    expect(accounting.entities).toHaveLength(20);
    expect(new Set(accounting.entities.map((e) => e.id)).size).toBe(20);
    // Every entity belongs to exactly one feature.
    const listed = accounting.features.flatMap((f) => f.entities).sort();
    expect(listed).toEqual(accounting.entities.map((e) => e.id).sort());
  });

  it("emits the seven events of the design and consumes every event through the posting engine marker", () => {
    expect(accounting.events.emits).toEqual([
      "accounting.entry.submitted", "accounting.entry.posted", "accounting.entry.reversed", "accounting.period.closed",
      "accounting.period.reopened", "accounting.year.closed", "accounting.posting.failed",
    ]);
    expect(Object.keys(accounting.events.consumes)).toEqual(["*", "kernel.module.enabled"]);
  });

  it("loads into a registry after core and registers every entity with i18n keys for labels", () => {
    const registry = new Registry();
    loadModules(registry, [core, accounting]);
    expect(registry.entities("accounting")).toHaveLength(20);
    for (const entity of ACCOUNTING_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });

  it("ledger_line is a query entity over v_ledger_lines whose grid consult is <entity>.list; the others are tables", () => {
    const line = ACCOUNTING_ENTITIES.find((e) => e.id === "accounting.ledger_line")!;
    expect(line.kind).toBe("query");
    expect(line.table).toBe("ledger_lines");
    expect(ACCOUNTING_ENTITIES.filter((e) => e.kind === "query")).toHaveLength(1);
  });

  it("the four dimensions are entities with the shared shape and their own table", () => {
    expect([...DIMENSIONS]).toEqual(["cost_center", "open_auxiliary", "item", "business_unit"]);
    for (const dimension of DIMENSIONS) {
      const entity = defineEntity(ACCOUNTING_ENTITIES.find((e) => e.id === `accounting.${dimension}`)!);
      expect(entity.fields.map((f) => f.name)).toEqual(
        expect.arrayContaining(["code", "name", "parent_id", "kind", "is_active", "seq", "extra", "extra_free"]),
      );
      expect(entity.fields.find((f) => f.name === "parent_id")?.ref?.entity).toBe(entity.id);
    }
  });

  it("references point at accounting.account (code), core.party (legal_name) and the dimensions (name)", () => {
    const line = defineEntity(ACCOUNTING_ENTITIES.find((e) => e.id === "accounting.entry_line")!);
    const target = (name: string) => line.fields.find((f) => f.name === name)?.ref;
    expect(target("account_id")).toEqual({ entity: "accounting.account", display: "code" });
    expect(target("party_id")).toEqual({ entity: "core.party", display: "legal_name" });
    expect(target("cost_center_id")).toEqual({ entity: "accounting.cost_center", display: "name" });
    expect(target("business_unit_id")).toEqual({ entity: "accounting.business_unit", display: "name" });
  });

  it("contributes the Contabilidad tab to every record, the revenue account to categories and Cuentas to roles and users; ten home KPIs", () => {
    const registry = new Registry();
    loadModules(registry, [core, accounting]);
    const ids = (entity: string) => registry.recordTabsFor(entity).map((t) => t.id);
    expect(ids("core.party")).toEqual(["accounting.entries"]);
    expect(ids("core.product_category")).toEqual(["accounting.entries", "accounting.category_revenue"]);
    expect(ids("kernel.role")).toEqual(["accounting.entries", "accounting.subject_accounts"]);
    expect(ids("kernel.user")).toEqual(["accounting.entries", "accounting.subject_accounts"]);
    const revenue = registry.recordTabsFor("core.product_category").find((t) => t.id === "accounting.category_revenue")!;
    expect(revenue).toMatchObject({ kind: "mapping", dimension: "category:{id}", roles: ["revenue"], lookupEntity: "accounting.account", saveProcess: "accounting.account_role_mapping.update" });
    // Every grid tab reads a registered entity.
    for (const tab of accounting.recordTabs ?? []) if (tab.kind === "grid") expect(registry.entity(tab.source!).id).toBe(tab.source);
    expect(accounting.homeKpis?.map((k) => k.id)).toEqual(["accounting.result_month", "accounting.income_month", "accounting.expenses_month", "accounting.margin_month", "accounting.working_capital", "accounting.current_ratio", "accounting.posted_entries", "accounting.pending_failures", "accounting.open_periods", "accounting.draft_entries"]);
  });
});

describe("people on accounting records are references (rule 21, T11)", () => {
  it("who submitted, posted or closed is a ref to kernel.user, so it reads as a name and links to the user", () => {
    const field = (entity: string, name: string) => ACCOUNTING_ENTITIES.find((e) => e.id === entity)?.fields.find((f) => f.name === name);
    for (const [entity, name] of [["accounting.entry", "submitted_by"], ["accounting.entry", "posted_by"], ["accounting.period", "closed_by"]] as const) {
      expect(field(entity, name)).toMatchObject({ type: "ref", ref: { entity: "kernel.user", display: "full_name" } });
    }
  });
});

describe("period names (T3)", () => {
  it("a period is named by its month: its display field starts_on reads as YYYY-MM", () => {
    const period = ACCOUNTING_ENTITIES.find((e) => e.id === "accounting.period")!;
    expect(period.displayField).toBe("starts_on");
    expect(period.fields.find((f) => f.name === "starts_on")?.displayFormat).toBe("month");
  });

  it("every process sits under a menu item or is declared shared: hiding an item refuses what its screen runs (spec §9.2)", () => {
    const registry = new Registry();
    loadModules(registry, [core, accounting]);
    const module = registry.module("accounting");
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    const under = (navKey: string) => menuItemsOf(module).find((r) => r.navKey === navKey)!.processIds;
    expect(under("accounting.periods")).toEqual(expect.arrayContaining(["accounting.year.close", "accounting.year.reopen", "accounting.period.close", "accounting.fiscal_year.open"]));
    expect(under("accounting.posting")).toEqual(expect.arrayContaining(["accounting.posting.retry", "accounting.settings.update", "accounting.chart.seed"]));
    expect(under("accounting.entries")).toEqual(expect.arrayContaining(["accounting.entry_template.create", "accounting.entry_template.consult", "accounting.opening.create", "accounting.opening.post"]));
    expect(under("accounting.accounts")).toEqual(expect.arrayContaining(["accounting.account_permission.update", "accounting.account_permission.consult"]));
    // Shared: read by many screens, never hidden with one of them.
    expect(module.menuShared).toEqual(["accounting.settings.consult"]);
  });
});
