import { describe, expect, it } from "vitest";
import { formatLabel } from "../date-format";

describe("formatLabel", () => {
  it("reads a bare date as AAAA/MM/DD and a month as its name", () => {
    expect(formatLabel("2026-10-01")).toBe("2026/10/01");
    expect(formatLabel("2026-10", "es-419")).toMatch(/octubre.*2026/i);
    expect(formatLabel("2026-10", "en")).toMatch(/October.*2026/);
  });
  it("an ISO instant reads in the company's zone; other text is untouched", () => {
    expect(formatLabel("2026-10-31T01:05:00.000Z", "es-419", "America/Bogota")).toBe("2026/10/30 20:05");
    expect(formatLabel("Café del Norte")).toBe("Café del Norte");
  });
});
