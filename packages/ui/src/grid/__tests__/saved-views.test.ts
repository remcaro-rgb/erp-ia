import { describe, expect, it } from "vitest";
import { keepGroups, viewFromSaved } from "../saved-views";
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
});
