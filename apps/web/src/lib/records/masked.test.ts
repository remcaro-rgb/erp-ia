import { describe, expect, it } from "vitest";
import { MASKED, moneyText } from "./masked";

// Rule 14 on a record's Datos tab (Task 20 fix round 1): a money the role does not see reads as the masked marker, never «$ 0,00».
describe("moneyText", () => {
  it("formats a visible amount and masks a masked, hidden or null one", () => {
    expect(moneyText("visible", "147700.0000", "COP")).toBe("$ 147.700,00");
    expect(moneyText("masked", null, "COP")).toBe(MASKED);
    expect(moneyText("hidden", "1", "COP")).toBe(MASKED);
    expect(moneyText(undefined, null, "COP")).toBe(MASKED);
    expect(moneyText(undefined, 0, "COP")).toBe("$ 0,00");
  });
});
