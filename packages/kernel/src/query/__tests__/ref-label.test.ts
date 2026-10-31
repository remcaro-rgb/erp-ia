import { describe, expect, it } from "vitest";
import { labelText } from "../ref-label";

// The text of a display field in a title or a reference label (T3, 2026-10-31): a driver `Date` never reaches the screen
// as the runtime's `toString` ("Wed Sep 30 2026 19:00:00 GMT-0500"), whatever the server's time zone.
describe("labelText", () => {
  it("a date at UTC midnight is YYYY-MM-DD, with no zone shift", () => {
    expect(labelText(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01");
    expect(labelText(new Date("2026-10-01T00:00:00Z"))).not.toMatch(/GMT/);
  });
  it("a period names its month; an instant keeps its ISO text; other values are their text", () => {
    expect(labelText(new Date("2026-10-01T00:00:00Z"), { displayFormat: "month" })).toBe("2026-10");
    expect(labelText("2026-10-01", { displayFormat: "month" })).toBe("2026-10");
    expect(labelText(new Date("2026-10-31T19:05:00Z"))).toBe("2026-10-31T19:05:00.000Z");
    expect(labelText(12)).toBe("12");
    expect(labelText("Café")).toBe("Café");
  });
});
