import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry, uncoveredMenuProcesses } from "@erp/kernel";
import { core } from "@erp/module-core";
import { support } from "../index";

describe("support manifest", () => {
  it("loads into a registry with its processes, entities, feature, event and menu item", () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, support]);
    expect(registry.processes({ module: "support" }).map((p) => p.id).sort()).toEqual(
      ["support.ticket.close", "support.ticket.consult", "support.ticket.create", "support.ticket.reply", "support.ticket_message.consult"].sort(),
    );
    expect(registry.entities("support").map((e) => e.id).sort()).toEqual(["support.ticket", "support.ticket_message"]);
    expect(support.dependsOn).toEqual(["core"]);
    expect(support.features.map((f) => f.id)).toEqual(["support.tickets"]);
    expect(support.events.emits).toEqual(["support.ticket.created"]);
    // The four menu sections (entity types spec §2.4) are empty: tickets are sistema records and Soporte stays a level-1 item.
    expect(support.navigation.map((n) => [n.id, n.children?.length])).toEqual([
      ["support.maestros", 0], ["support.documentos", 0], ["support.reportes", 0], ["support.parametros", 0], ["support.tickets", undefined],
    ]);
    expect(support.navigation.at(-1)).toEqual({
      id: "support.tickets", label: "nav.support.tickets", href: "/support", icon: "life-buoy", feature: "support.tickets", entity: "support.ticket", runs: ["support.ticket_message."],
    });
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

  it("the reporter is a reference to the user who filed the ticket (rule 21: it links to their page)", () => {
    const ticket = support.entities.find((e) => e.id === "support.ticket")!;
    expect(ticket.fields.find((f) => f.name === "reporter_user_id")).toMatchObject({ type: "ref", ref: { entity: "kernel.user", display: "full_name" } });
  });

  it("every process sits under a menu item: hiding Tickets refuses what its screen runs (spec §9.2)", () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, support]);
    expect(uncoveredMenuProcesses(registry.module("support"))).toEqual([]);
  });
});
