import { describe, expect, it } from "vitest";
import { buildTree, expandToLevel, filterTree, openForMatches, visibleNodes } from "../tree-model";

// Four levels of a chart: class 1, group 13, account 1305, subaccount 130505; a second class 2 with its group.
const rows = [
  { id: "c1", parent: null, code: "1", name: "Activo" },
  { id: "g13", parent: "c1", code: "13", name: "Deudores" },
  { id: "a1305", parent: "g13", code: "1305", name: "Clientes" },
  { id: "s130505", parent: "a1305", code: "130505", name: "Nacionales" },
  { id: "c2", parent: null, code: "2", name: "Pasivo" },
  { id: "g22", parent: "c2", code: "22", name: "Proveedores" },
];
const tree = () => buildTree(rows, { idField: "id", parentField: "parent" });

describe("tree model", () => {
  it("buildTree nests by parent and expandToLevel(2) opens classes and groups only", () => {
    const roots = tree();
    expect(roots.map((n) => n.id)).toEqual(["c1", "c2"]);
    expect(roots[0]!.children.map((n) => n.id)).toEqual(["g13"]);
    expect(roots[0]!.children[0]!.children[0]!.children[0]).toMatchObject({ id: "s130505", depth: 3 });

    const open = expandToLevel(roots, 2);
    // Classes and groups are open: the accounts show, the subaccounts do not.
    expect([...open].sort()).toEqual(["c1", "c2", "g13", "g22"]);
    expect(visibleNodes(roots, open).map((n) => n.id)).toEqual(["c1", "g13", "a1305", "c2", "g22"]);
  });

  it("a row whose parent is missing becomes a root, and a parent cycle is cut", () => {
    const roots = buildTree(
      [
        { id: "a", parent: "ghost" },
        { id: "b", parent: "c" },
        { id: "c", parent: "b" },
      ],
      { idField: "id", parentField: "parent" },
    );
    expect(roots.map((n) => n.id).sort()).toEqual(["a", "c"]);
    expect(roots.find((n) => n.id === "c")!.children.map((n) => n.id)).toEqual(["b"]);
  });

  it("filterTree keeps the matching nodes with their ancestors, ignoring case and accents", () => {
    const byName = filterTree(tree(), "CLIENTES");
    expect(byName.map((n) => n.id)).toEqual(["c1"]);
    expect(visibleNodes(byName, openForMatches(byName, "CLIENTES")).map((n) => n.id)).toEqual(["c1", "g13", "a1305"]);
    expect(filterTree(tree(), "1305").map((n) => n.id)).toEqual(["c1"]);
    expect(filterTree(tree(), "zzz")).toEqual([]);
    expect(filterTree(tree(), "  ")).toHaveLength(2);
  });
});
