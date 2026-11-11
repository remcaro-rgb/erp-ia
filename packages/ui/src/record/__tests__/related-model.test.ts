import { describe, expect, it } from "vitest";
import { recordTabIds, relatedModel, type RelatedNode } from "../../index";

// Task 31 stage D (design §22.27, R31-8): the tab «Documentos relacionados» is drawn from the trail consult alone.

const node = (over: Partial<RelatedNode> & { id: string }): RelatedNode => ({ direction: "up", depth: 1, kind: "order_to_delivery", entity: "x.doc", voided: false, label: over.id.toUpperCase(), ...over });

describe("relatedModel", () => {
  it("has no tab when there are no nodes and nothing hidden", () => {
    expect(relatedModel({ nodes: [], hidden: 0, truncated: false })).toBeNull();
  });

  it("shows the tab with only a hidden count", () => {
    const model = relatedModel({ nodes: [], hidden: 2, truncated: false })!;
    expect(model.entries).toEqual([]);
    expect(model.hidden).toBe(2);
    expect(model.count).toBe(2);
  });

  it("puts upstream before downstream, by depth, keeping the walk's order inside a level", () => {
    const model = relatedModel({
      nodes: [node({ id: "d1", direction: "down", depth: 1 }), node({ id: "u2", depth: 2 }), node({ id: "u1", depth: 1 }), node({ id: "d2", direction: "down", depth: 2 }), node({ id: "u1b", depth: 1 })],
      hidden: 0,
      truncated: false,
    })!;
    expect(model.entries.map((e) => e.id)).toEqual(["u1", "u1b", "u2", "d1", "d2"]);
    expect(model.entries.map((e) => e.indent)).toEqual([0, 0, 1, 0, 1]);
    expect(model.count).toBe(5);
  });

  it("carries the voided flag and the label, and a null kind for a node reached through a hidden one", () => {
    const model = relatedModel({ nodes: [node({ id: "a", voided: true }), node({ id: "b", kind: null })], hidden: 1, truncated: true })!;
    expect(model.entries.find((e) => e.id === "a")).toMatchObject({ voided: true, label: "A", kind: "order_to_delivery" });
    expect(model.entries.find((e) => e.id === "b")!.kind).toBeNull();
    expect(model.hidden).toBe(1);
    expect(model.truncated).toBe(true);
    expect(model.shown).toBe(3);
    expect(model.count).toBe(3);
  });

  it("the truncated line counts the documents the cap counted, so it is never 0 when the viewer sees none of them", () => {
    const model = relatedModel({ nodes: [], hidden: 100, truncated: true })!;
    expect(model.entries).toHaveLength(0);
    expect(model.shown).toBe(100);
  });

  it("every entry names the record page it links to (rule 21)", () => {
    const model = relatedModel({ nodes: [node({ id: "0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", entity: "sales.order" })], hidden: 0, truncated: false })!;
    expect(model.entries[0]!.href).toBe("/r/sales.order/0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
  });
});

describe("recordTabIds", () => {
  it("offers Documentos relacionados (relacionados) before Datos adicionales on every record", () => {
    for (const entity of ["core.party", "invoicing.invoice", "sales.order"]) {
      const ids = recordTabIds(entity);
      expect(ids.indexOf("relacionados")).toBeGreaterThan(0);
      expect(ids.indexOf("relacionados")).toBe(ids.indexOf("extra") - 1);
    }
  });
});
