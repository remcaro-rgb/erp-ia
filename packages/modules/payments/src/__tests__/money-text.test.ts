import { describe, expect, it } from "vitest";
import { money } from "../processes/common";

// Task 34.2 (item 129): the money text of a refusal names its currency; `money` replaces `pesos`.

describe("money (the text of a refusal)", () => {
  it("COP as $ 1.234.567,00 and another currency by its ISO code, sign first", () => {
    expect(money(1234567, "COP")).toBe("$ 1.234.567,00");
    expect(money(12500, "USD")).toBe("USD 12.500,00");
    expect(money(-1000, "COP")).toBe("-$ 1.000,00");
    expect(money(-1000, "USD")).toBe("-USD 1.000,00");
  });
});
