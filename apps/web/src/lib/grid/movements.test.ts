import { describe, expect, it } from "vitest";
import { defaultMovementsState } from "./movements";

// Movimientos (accounting design §5.14): the grid opens on the open period, posted lines, in comprobante order.

const period = { startsOn: "2026-10-01", endsOn: "2026-10-31" };

describe("movements default state", () => {
  it("the Movimientos default state is the open period, posted, sorted date/number/line_no", () => {
    const state = defaultMovementsState(period);
    expect(state.filters).toEqual([
      { field: "date", op: "between", value: "2026-10-01", value2: "2026-10-31" },
      { field: "status", op: "eq", value: "posted", join: "and" },
    ]);
    expect(state.sort).toEqual([
      { field: "date", dir: "asc" },
      { field: "number", dir: "asc" },
      { field: "line_no", dir: "asc" },
    ]);
  });

  it("without an open period it still filters posted lines and leaves the date free", () => {
    const state = defaultMovementsState(null);
    expect(state.filters).toEqual([{ field: "status", op: "eq", value: "posted" }]);
    expect(state.sort?.map((s) => s.field)).toEqual(["date", "number", "line_no"]);
  });

  it("shows the columns of §5.14, adding the dimensions that are in use after the cost center", () => {
    const off = defaultMovementsState(period).columns;
    expect(off).toEqual(["date", "number", "journal_code", "account_code", "account_name", "party_name", "cost_center_name", "description", "debit", "credit", "net", "status"]);
    const on = defaultMovementsState(period, { openAuxiliaries: true, items: true, businessUnits: true }).columns;
    expect(on).toEqual([
      "date", "number", "journal_code", "account_code", "account_name", "party_name", "cost_center_name",
      "open_auxiliary_name", "item_name", "business_unit_name", "description", "debit", "credit", "net", "status",
    ]);
    expect(defaultMovementsState(period, { items: true }).columns).toContain("item_name");
    expect(defaultMovementsState(period, { items: true }).columns).not.toContain("business_unit_name");
  });
});
