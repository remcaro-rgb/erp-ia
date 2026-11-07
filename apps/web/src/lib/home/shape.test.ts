import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { helpShortcuts, recentHref, recommendationItem, subjectHref } from "./shape";

const registry = new Registry();
loadModules(registry, [kernelModule, core, support]);
const of = (id: string) => registry.entity(id);

// Pure rules of the home page: where a recent record opens, and which help shortcuts the screens the caller has make sense.

describe("recentHref", () => {
  it("opens a record that has a full page, else the entity's grid, else nothing", () => {
    expect(recentHref(of("core.party"), "p1")).toBe("/r/core.party/p1");
    expect(recentHref(of("core.product_category"), "c1")).toBe("/r/core.product_category/c1");
    expect(recentHref(of("kernel.export_job"), "j1")).toBeNull();
    expect(recentHref(null, "x1")).toBeNull();
    // Every record with a page links there (rule 21): a ticket in its frame, a user under Administración › Usuarios.
    expect(recentHref(of("support.ticket"), "t1")).toBe("/r/support.ticket/t1");
    expect(recentHref(of("kernel.user"), "u1")).toBe("/admin/users/u1");
  });
});

describe("helpShortcuts", () => {
  it("offers only the guides of screens the caller can open, always the two-step one", () => {
    expect(helpShortcuts(["/parties", "/products"]).map((s) => s.id)).toEqual(["parties", "products", "listings", "two_factor"]);
    expect(helpShortcuts(["/import"]).map((s) => s.id)).toEqual(["import", "two_factor"]);
    expect(helpShortcuts([]).map((s) => s.id)).toEqual(["two_factor"]);
  });

  it("carries the i18n key of the question each shortcut asks the assistant", () => {
    expect(helpShortcuts(["/parties"])[0]).toEqual({ id: "parties", questionKey: "home.help.parties.question", labelKey: "home.help.parties.label" });
  });
});

// Where a recommendation a process raised opens (plan 2B Task 38): the record's page, else the list page of its entity the caller has in
// the menu, else nothing (the card says «Sin acceso al registro»); a subject the kernel hid from the caller opens nothing.
describe("subjectHref", () => {
  const nav = [{ entity: "core.uom", href: "/uoms" }];
  it("opens the record's page, else its entity's list page in the caller's menu, else nothing", () => {
    expect(subjectHref(registry, nav, { entity: "core.party", id: "p1" })).toBe("/r/core.party/p1");
    expect(subjectHref(registry, nav, { entity: "core.uom", id: "u1" })).toBe("/uoms");
    expect(subjectHref(registry, [], { entity: "core.uom", id: "u1" })).toBeNull();
    expect(subjectHref(registry, nav, { entity: "nope.thing", id: "x" })).toBeNull();
    expect(subjectHref(registry, nav, null)).toBeNull();
  });
});

describe("recommendationItem", () => {
  it("hands the card the keys, the masked params, the reason's key and the link", () => {
    const item = recommendationItem(registry, [], {
      id: "r1", source: "process", agentProfile: "process", title: "t", body: "b", confidence: null, suggestedActions: [], createdAt: "2026-11-06T00:00:00.000Z",
      module: "invoicing", reason: "over_invoicing", titleKey: "invoicing.recommendation.auto_skipped.title", bodyKey: "invoicing.recommendation.auto_skipped.body",
      params: { document: null }, subject: { entity: "core.party", id: "p1" }, occurrences: 2, lastRaisedAt: null,
    });
    expect(item).toEqual({
      id: "r1", source: "process", agentProfile: "process", title: "t", body: "b", confidence: null, suggestedActions: [], module: "invoicing",
      titleKey: "invoicing.recommendation.auto_skipped.title", bodyKey: "invoicing.recommendation.auto_skipped.body",
      reason: "over_invoicing", reasonKey: "invoicing.recommendation.reason.over_invoicing", params: { document: null }, href: "/r/core.party/p1",
    });
  });
});
