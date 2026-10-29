import { describe, expect, it } from "vitest";
import { initialView, moveColumn, setColumnShown } from "../grid-model";
import { keepGroups, savedStateOf, viewFromSaved } from "../saved-views";
import type { GridColumn } from "../types";

// A saved view comes back with what the caller may still use (rule 14: masked and hidden fields never filter or sort).

const col = (field: string, mode: GridColumn["mode"]): GridColumn => ({ field, label: field, type: "text", kind: "text", mode, filterable: true, sortable: true });
const columns = [col("legal_name", "visible"), col("trade_name", "visible"), col("balance", "masked"), col("secret", "hidden")];

describe("saved views", () => {
  it("drops conditions on masked and hidden fields and keeps the OR groups", () => {
    // (legal_name y balance) o (balance y trade_name) o (secret)  →  (legal_name) o (trade_name)
    const kept = keepGroups(
      [
        { field: "legal_name", op: "contains", value: "a" },
        { field: "balance", op: "gt", value: 1, join: "and" },
        { field: "balance", op: "gt", value: 2, join: "or" },
        { field: "trade_name", op: "contains", value: "b", join: "and" },
        { field: "secret", op: "contains", value: "c", join: "or" },
      ],
      (f) => f === "legal_name" || f === "trade_name",
    );
    expect(kept).toEqual([
      { field: "legal_name", op: "contains", value: "a", join: undefined },
      { field: "trade_name", op: "contains", value: "b", join: "or" },
    ]);
  });

  it("restores the view without masked sorts, hidden columns or masked conditions", () => {
    const view = viewFromSaved(columns, {
      filters: [
        { field: "balance", op: "gt", value: 1 },
        { field: "legal_name", op: "contains", value: "a", join: "and" },
      ],
      sort: [
        { field: "balance", dir: "asc" },
        { field: "legal_name", dir: "desc" },
      ],
      pageSize: 25,
      columns: ["legal_name", "balance", "secret"],
    });
    expect(view.conditions).toEqual([{ field: "legal_name", op: "contains", value: "a", join: undefined }]);
    expect(view.sort).toEqual([{ field: "legal_name", dir: "desc" }]);
    expect(view.columns).toEqual(["legal_name", "balance"]);
    expect(view.pageSize).toBe(25);
  });

  describe("the column order (design §22.12, M-1)", () => {
    const four = [col("legal_name", "visible"), col("trade_name", "visible"), col("city", "visible"), col("phone", "visible")];

    it("a column moved, then hidden, comes back at its moved place when shown again after a save and restore", () => {
      // phone moved first, then hidden.
      const moved = moveColumn(initialView(four), "phone", 0);
      expect(moved.columns).toEqual(["phone", "legal_name", "trade_name", "city"]);
      const hidden = setColumnShown(moved, "phone", false);
      expect(hidden.columns).toEqual(["legal_name", "trade_name", "city"]);

      const saved = savedStateOf(four, hidden);
      expect(saved.columns).toEqual(["legal_name", "trade_name", "city"]);
      expect(saved.order).toEqual(["phone", "legal_name", "trade_name", "city"]);

      const restored = viewFromSaved(four, JSON.parse(JSON.stringify(saved)));
      expect(restored.columns).toEqual(["legal_name", "trade_name", "city"]);
      expect(setColumnShown(restored, "phone", true).columns).toEqual(["phone", "legal_name", "trade_name", "city"]);
    });

    it("an older view saved without order places the columns it does not show by the declared order", () => {
      const restored = viewFromSaved(four, { columns: ["city", "legal_name"] });
      expect(restored.columns).toEqual(["city", "legal_name"]);
      // phone follows city in the declared order, trade_name follows legal_name.
      expect(restored.order).toEqual(["city", "phone", "legal_name", "trade_name"]);
      expect(setColumnShown(restored, "phone", true).columns).toEqual(["city", "phone", "legal_name"]);
    });

    it("drops fields of the saved order the caller no longer sees", () => {
      const restored = viewFromSaved([...four, col("secret", "hidden")], { columns: ["legal_name"], order: ["secret", "phone", "legal_name", "trade_name", "city"] });
      expect(restored.order).toEqual(["phone", "legal_name", "trade_name", "city"]);
    });
  });
});
