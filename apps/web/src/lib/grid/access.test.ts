import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { core } from "@erp/module-core";
import { consultProcessesOf, gridEntity } from "./access";

// The process that opens an entity's grid is the entity's own consult, never another entity's of the same feature.

const registry = new Registry();
loadModules(registry, [kernelModule, core]);
const of = (id: string) => consultProcessesOf(registry, gridEntity(registry, id)!);

describe("grid access", () => {
  it("maps each entity to its own consult process", () => {
    expect(of("core.party")).toEqual(["core.party.consult"]);
    expect(of("core.product")).toEqual(["core.product.consult"]);
    expect(of("core.product_category")).toEqual(["core.category.consult"]);
    expect(of("core.price_list")).toEqual(["core.price_list.consult"]);
    expect(of("core.price_list_item")).toEqual(["core.price_list_item.consult"]);
    expect(of("core.uom")).toEqual(["core.uom.consult"]);
    expect(of("core.party_contact")).toEqual(["core.party_contact.consult"]);
    expect(of("core.document_sequence")).toEqual(["core.document_sequence.consult"]);
  });

  it("an entity without its own consult has none to offer", () => {
    const bare = new Registry();
    loadModules(bare, [kernelModule]);
    bare.registerEntity({ ...gridEntity(registry, "core.uom")!, id: "kernel.probe", module: "kernel" });
    expect(consultProcessesOf(bare, gridEntity(bare, "kernel.probe")!)).toEqual([]);
  });
});
