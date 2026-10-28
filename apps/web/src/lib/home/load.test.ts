import { describe, expect, it } from "vitest";
import { firstNameOf, greetingPeriod } from "./load";

describe("greetingPeriod", () => {
  it("follows the clock of the company's time zone, not the server's", () => {
    // 2026-10-28 14:30 UTC is 09:30 in Bogotá, 23:30 in Tokyo.
    const at = new Date("2026-10-28T14:30:00Z");
    expect(greetingPeriod(at, "America/Bogota")).toBe("morning");
    expect(greetingPeriod(at, "Asia/Tokyo")).toBe("evening");
    expect(greetingPeriod(new Date("2026-10-28T19:00:00Z"), "America/Bogota")).toBe("afternoon");
  });

  it("the small hours are still the evening's, noon starts the afternoon", () => {
    expect(greetingPeriod(new Date("2026-10-28T05:00:00Z"), "America/Bogota")).toBe("evening");
    expect(greetingPeriod(new Date("2026-10-28T10:00:00Z"), "America/Bogota")).toBe("morning");
    expect(greetingPeriod(new Date("2026-10-28T17:00:00Z"), "America/Bogota")).toBe("afternoon");
  });
});

describe("firstNameOf", () => {
  it("greets by the first word of the name, or the local part of the e-mail", () => {
    expect(firstNameOf("Laura Martínez")).toBe("Laura");
    expect(firstNameOf("  Ana  ")).toBe("Ana");
    expect(firstNameOf("marcela@demo.local")).toBe("marcela");
  });
});
