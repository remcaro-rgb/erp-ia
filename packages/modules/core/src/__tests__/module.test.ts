import { describe, it, expect } from "vitest";
import { loadModules, Registry } from "@erp/kernel";
import { core } from "../index";

describe("core manifest", () => {
  it("loads into a registry with every brief process, entity and feature", () => {
    const registry = new Registry();
    loadModules(registry, [core]);
    expect(registry.processes({ module: "core" }).map((p) => p.id).sort()).toEqual(
      [
        "core.party.create", "core.party.update", "core.party.deactivate", "core.party.consult",
        "core.contact.create", "core.contact.update", "core.contact.delete",
        "core.category.create", "core.category.update", "core.category.consult",
        "core.product.create", "core.product.update", "core.product.deactivate", "core.product.consult",
        "core.sequence.next",
      ].sort(),
    );
    expect(registry.entities("core").map((e) => e.id)).toEqual(
      expect.arrayContaining(["core.party", "core.product", "core.uom", "core.price_list", "core.party_contact", "core.product_category"]),
    );
    expect(core.features.map((f) => f.id)).toEqual(["core.parties", "core.products", "core.settings"]);
    expect(core.events.emits).toEqual(["core.party.created", "core.party.updated", "core.product.created", "core.product.updated"]);
    expect(core.navigation.map((n) => n.href)).toEqual(["/parties", "/products", "/categories"]);
  });

  it("every process belongs to exactly one feature, and labels are i18n keys", () => {
    const listed = core.features.flatMap((f) => f.processes);
    expect(listed.sort()).toEqual(core.processes.map((p) => p.id).sort());
    for (const entity of core.entities) {
      expect(entity.label).toBe(`entity.${entity.id}`);
      for (const field of entity.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });
});
