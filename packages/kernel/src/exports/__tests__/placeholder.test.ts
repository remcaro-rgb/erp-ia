import { describe, expect, it } from "vitest";
import { cellOf, cellText } from "../format";
import { flatten, PLACEHOLDER_CELL } from "../plan";
import type { ExportColumn } from "../types";

// D20 round 2: a «••••» placeholder row (a line the caller may not see) exports «••••» in every cell its view masks, never an empty
// cell and never a hidden value; its own values (the line number) export as they are.
const col = (field: string, type: ExportColumn["type"]): ExportColumn => ({ field, label: field, type }) as ExportColumn;
const columns = [col("line_no", "number"), col("debit", "money"), col("description", "text")];

describe("placeholder rows in an export", () => {
  it("masked cells of a placeholder row print «••••»; the same empty cell of an ordinary row stays empty", () => {
    const masked = new Set(["debit", "description"]);
    const placeholder = flatten({ id: "1", line_no: 2, debit: null, description: null, __row_masked: true }, columns, [], new Set(), masked);
    expect(placeholder).toMatchObject({ line_no: 2, debit: PLACEHOLDER_CELL, description: PLACEHOLDER_CELL });
    expect(cellText(columns[1]!, placeholder.debit)).toBe("••••");
    expect(cellOf(columns[2]!, placeholder.description)).toEqual({ type: "text", value: "••••" });
    const ordinary = flatten({ id: "2", line_no: 3, debit: null, description: null }, columns, [], new Set(), masked);
    expect(ordinary).toMatchObject({ debit: null, description: null });
  });
});
