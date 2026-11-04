import { describe, expect, it } from "vitest";
import { templateLinesOf } from "./entry-template";

const lines = [
  { line_no: 1, account_id: "a1", debit: 3_000_000, credit: 0, cost_center_id: "cc", description: "Arriendo", is_restricted: false },
  { line_no: 2, account_id: "a2", debit: 0, credit: 3_000_000, party_id: "p1", is_restricted: false },
];

describe("templateLinesOf", () => {
  it("maps each line to a side, its amount and its links", () => {
    expect(templateLinesOf(lines, false)).toEqual({
      ok: true,
      lines: [
        { accountId: "a1", side: "debit", amount: 3_000_000, costCenterId: "cc", description: "Arriendo" },
        { accountId: "a2", side: "credit", amount: 3_000_000, partyId: "p1" },
      ],
    });
  });
  it("leaves the amounts open when asked", () => {
    const result = templateLinesOf(lines, true);
    expect(result.ok && result.lines.map((l) => l.amount)).toEqual([undefined, undefined]);
  });
  it("refuses a restricted line, whose account the viewer cannot see", () => {
    expect(templateLinesOf([{ line_no: 1, account_id: null, debit: null, credit: null, is_restricted: true }], false)).toEqual({ ok: false });
  });
  it("refuses an entry with no lines", () => {
    expect(templateLinesOf([], false)).toEqual({ ok: false });
  });
});
