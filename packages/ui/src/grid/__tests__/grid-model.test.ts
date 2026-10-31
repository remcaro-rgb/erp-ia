import { describe, expect, it } from "vitest";
import { initialView, toGridState } from "../grid-model";
import type { GridColumn } from "../types";

// Grouping and aggregates in the state a grid sends (accounting design §5.14): one aggregate per money column and chosen function.

const col = (field: string, type: string, kind: GridColumn["kind"] = "text"): GridColumn => ({ field, label: field, type, kind, mode: "visible", filterable: true, sortable: true });
const cols = [col("a", "text"), col("debit", "money", "number"), col("credit", "money", "number")];

describe("toGridState", () => {
  it("sends one aggregate per money column and chosen function", () => {
    const view = { ...initialView(cols), groupBy: ["a"], aggregateFns: ["sum", "avg"] as const };
    expect(toGridState(cols, { ...view, aggregateFns: [...view.aggregateFns] }).aggregates).toEqual([
      { field: "debit", fn: "sum" },
      { field: "debit", fn: "avg" },
      { field: "credit", fn: "sum" },
      { field: "credit", fn: "avg" },
    ]);
    expect(toGridState(cols, { ...view, aggregateFns: ["sum"] }).groupBy).toEqual(["a"]);
  });

  it("without groups it sends the sums and no groupBy", () => {
    const state = toGridState(cols, initialView(cols));
    expect(state.aggregates).toEqual([{ field: "debit", fn: "sum" }, { field: "credit", fn: "sum" }]);
    expect(state.groupBy).toBeUndefined();
  });
});

describe("selectionTotals, roll-up columns (UX-OD-3, T4)", async () => {
  const { selectionTotals } = await import("../grid-model");
  const figure = { field: "figure", label: "Cifra", type: "money", kind: "number", mode: "visible", filterable: true, sortable: true, rollup: true } as const;
  const own = { ...figure, field: "own", rollup: undefined };
  const rows = [
    { id: "g", parent_id: null, figure: "100", own: "100" },
    { id: "a", parent_id: "g", figure: "60", own: "60" },
    { id: "b", parent_id: "g", figure: "40", own: "40" },
    { id: "x", parent_id: "a", figure: "10", own: "10" },
  ];
  const sums = (ids: string[]) => Object.fromEntries(selectionTotals(rows, new Set(ids), [figure, own]).map((t) => [t.column.field, t.sum]));

  it("a group selected with its child counts once; the ordinary column keeps the plain sum", () => {
    expect(sums(["g", "a"])).toEqual({ figure: 100, own: 160 });
  });
  it("two leaves count both; a grandchild under a selected ancestor is covered by it, however far up", () => {
    expect(sums(["a", "b"])).toEqual({ figure: 100, own: 100 });
    expect(sums(["g", "x"])).toEqual({ figure: 100, own: 110 });
    expect(sums(["a"])).toEqual({ figure: 60, own: 60 });
  });
});

describe("selectionTotals without the hierarchy (T4 review)", async () => {
  const { selectionTotals } = await import("../grid-model");
  it("a roll-up column has no total when the rows do not carry parent_id", () => {
    const col = { field: "figure", label: "Cifra", type: "money", kind: "number", mode: "visible", filterable: true, sortable: true, rollup: true } as const;
    expect(selectionTotals([{ id: "a", figure: "5" }], new Set(["a"]), [col])[0]!.sum).toBeNull();
  });
});
