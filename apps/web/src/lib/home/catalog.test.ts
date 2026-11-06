import { describe, expect, it } from "vitest";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { inventory } from "@erp/module-inventory";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { sales } from "@erp/module-sales";
import { catalogKey, kernelModule, loadModules, Registry } from "@erp/kernel";
import { support } from "@erp/module-support";
import { messages, type Messages } from "@erp/i18n";

// Every KPI and chart a module ships appears in "Personalizar página de inicio" with a name and a one-line description, and the
// charts and KPIs the home screen draws have their texts, in both languages.

const registry = new Registry();
// The app's modules (src/lib/server/runtime.ts), the 2B sale chain included (plan 2B Task 26).
loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments]);
const providers = [...registry.kpiProviders().map((p) => ({ ...p, kind: "kpi" as const })), ...registry.chartProviders().map((p) => ({ ...p, kind: "chart" as const }))];

const lookup = (tree: Messages, key: string): unknown => key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), tree);

describe("the Inicio catalogue", () => {
  it("every module has indicators and charts of its own", () => {
    for (const moduleId of ["accounting", "core", "support", "kernel"]) {
      expect(providers.filter((p) => p.id.startsWith(`${moduleId}.`) && p.kind === "kpi").length, `${moduleId} indicators`).toBeGreaterThanOrEqual(2);
      expect(providers.filter((p) => p.id.startsWith(`${moduleId}.`) && p.kind === "chart").length, `${moduleId} charts`).toBeGreaterThanOrEqual(2);
    }
  });

  it("the sale chain's modules have their Inicio cards: Por cobrar, Por facturar, Pedidos abiertos, Stock bajo mínimo, Pipeline", () => {
    for (const moduleId of ["crm", "sales", "inventory", "costing", "invoicing", "payments"]) {
      expect(providers.filter((p) => p.id.startsWith(`${moduleId}.`) && p.kind === "kpi").length, `${moduleId} indicators`).toBeGreaterThanOrEqual(1);
    }
    expect(providers.map((p) => p.id)).toEqual(expect.arrayContaining(["invoicing.receivable", "invoicing.to_invoice", "sales.open_orders", "inventory.below_minimum", "crm.pipeline", "invoicing.sales_by_month", "crm.pipeline_by_stage"]));
    const tree = messages("es-419");
    const names = ["invoicing.receivable", "invoicing.to_invoice", "sales.open_orders", "inventory.below_minimum", "crm.pipeline"].map((id) => lookup(tree, catalogKey(id, "label")));
    expect(names).toEqual(["Por cobrar", "Por facturar", "Pedidos abiertos", "Stock bajo mínimo", "Pipeline"]);
  });

  it.each(["es-419", "en"] as const)("every provider has a name and a description in %s", (locale) => {
    const tree = messages(locale);
    const missing = providers.flatMap((p) => (["label", "description"] as const).map((part) => catalogKey(p.id, part))).filter((key) => typeof lookup(tree, key) !== "string");
    expect(missing).toEqual([]);
  });

  it("the catalogue names are unique and the descriptions are short sentences", () => {
    const tree = messages("es-419");
    const labels = providers.map((p) => lookup(tree, catalogKey(p.id, "label")) as string);
    expect(new Set(labels).size).toBe(labels.length);
    for (const p of providers) {
      const description = lookup(tree, catalogKey(p.id, "description")) as string;
      expect(description.length, p.id).toBeGreaterThan(20);
      expect(description.length, p.id).toBeLessThan(140);
    }
  });
});
