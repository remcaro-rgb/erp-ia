import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { support } from "../index";

describe("support manifest", () => {
  it("loads into a registry with its processes, entities, feature, event and menu item", () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, support]);
    expect(registry.processes({ module: "support" }).map((p) => p.id).sort()).toEqual(
      ["support.ticket.close", "support.ticket.consult", "support.ticket.create", "support.ticket.reply", "support.ticket_message.consult"].sort(),
    );
    expect(registry.entities("support").map((e) => e.id).sort()).toEqual(["support.ticket", "support.ticket_message"]);
    expect(support.dependsOn).toEqual([]);
    expect(support.features.map((f) => f.id)).toEqual(["support.tickets"]);
    expect(support.events.emits).toEqual(["support.ticket.created"]);
    expect(support.navigation).toEqual([{ id: "support.tickets", label: "nav.support.tickets", href: "/support", icon: "life-buoy", feature: "support.tickets" }]);
  });

  it("every entity has its own consult process, every process belongs to the feature, labels are i18n keys", () => {
    const consults = new Set(support.processes.filter((p) => p.kind === "consult").map((p) => p.id));
    for (const entity of support.entities) {
      expect(consults.has(`${entity.id}.consult`), entity.id).toBe(true);
      expect(entity.label).toBe(`entity.${entity.id}`);
      for (const field of entity.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
    expect(support.features.flatMap((f) => f.processes).sort()).toEqual(support.processes.map((p) => p.id).sort());
  });

  it("the ticket context is a sensitive field by default", () => {
    const ticket = support.entities.find((e) => e.id === "support.ticket")!;
    expect(ticket.fields.find((f) => f.name === "context")?.sensitivity).toBe("confidential");
    expect(ticket.processIds).toEqual({ attach: "support.ticket.reply" });
  });
});
