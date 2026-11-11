import { describe, expect, it } from "vitest";
import { gateOf } from "../resolver";

// Task 50.9: one answer for the dispatcher, the inline poster and Admin › Módulos.
describe("gateOf", () => {
  it("bought and on is enabled; the company's switch off is switched_off whatever the purchase; never bought is not_purchased; the kernel is always enabled", () => {
    expect(gateOf({ purchased: true, disabled: false })).toBe("enabled");
    expect(gateOf({ purchased: true, disabled: true })).toBe("switched_off");
    expect(gateOf({ purchased: false, disabled: true })).toBe("switched_off");
    expect(gateOf({ purchased: false, disabled: false })).toBe("not_purchased");
    expect(gateOf({ moduleId: "kernel", purchased: false, disabled: true })).toBe("enabled");
  });
});
