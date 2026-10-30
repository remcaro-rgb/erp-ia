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
