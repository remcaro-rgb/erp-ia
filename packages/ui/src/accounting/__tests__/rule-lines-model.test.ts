import { describe, expect, it } from "vitest";
import { blankRuleLine, cleanLines, linesIncomplete, linesOf, ruleLinesInput, setLineField, type RuleLine } from "../rule-lines-model";

const lines: RuleLine[] = [
  { role: "receivable", side: "debit", amount: "$.totals.total", party: "$.customer.partyId" },
  { role: "revenue", side: "credit", amount: "$.lines[*].subtotal", forEach: "$.lines[*]", dimension: "category:$.lines[*].categoryId" },
];

describe("rule lines model", () => {
  it("a role and a fixed account exclude each other", () => {
    const fixed = setLineField(lines, 0, "account", "130505");
    expect(fixed[0]!.role).toBeUndefined();
    expect(fixed[0]!.account).toBe("130505");
    const back = setLineField(fixed, 0, "role", "receivable");
    expect(back[0]!.account).toBeUndefined();
    expect(setLineField(lines, 1, "role", "cash")[1]).toMatchObject({ role: "cash", forEach: "$.lines[*]" });
    // Emptying one leaves the other as it is.
    expect(setLineField(lines, 0, "account", "")[0]!.role).toBe("receivable");
  });

  it("the saved lines keep the template's other keys and drop the empty paths", () => {
    const edited = setLineField(setLineField(lines, 0, "party", "  "), 1, "role", "sales_returns");
    expect(cleanLines(edited)[0]).toEqual({ role: "receivable", side: "debit", amount: "$.totals.total" });
    const input = ruleLinesInput("r-1", { description: "Factura", date: "$.date", lines }, edited);
    expect(input).toMatchObject({ id: "r-1", template: { description: "Factura", date: "$.date" } });
    expect((input.template as { lines: RuleLine[] }).lines[1]).toMatchObject({ role: "sales_returns", forEach: "$.lines[*]" });
  });

  it("a line without a role or account, or without an amount, is incomplete; a new line is", () => {
    expect(linesIncomplete(lines)).toBe(false);
    expect(linesIncomplete([blankRuleLine()])).toBe(true);
    expect(linesIncomplete([])).toBe(true);
    expect(linesIncomplete([{ side: "debit", amount: "$.a", account: "110505" }])).toBe(false);
  });

  it("reads the lines of a stored template", () => {
    expect(linesOf({ lines })).toHaveLength(2);
    expect(linesOf(null)).toEqual([]);
    expect(linesOf({ lines: "x" })).toEqual([]);
  });
});
