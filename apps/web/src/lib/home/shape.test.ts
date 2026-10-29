import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { helpShortcuts, recentHref } from "./shape";

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
