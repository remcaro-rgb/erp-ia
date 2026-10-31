import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// T10 (2026-10-31): the report filters wrap and keep a minimum width instead of truncating at 1280 px with the assistant open.
const css = readFileSync(join(import.meta.dirname, "..", "..", "styles", "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.[\]()]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

describe("report parameter bar styles", () => {
  it("the bar wraps and each control keeps a minimum width", () => {
    expect(rule(".erp-report__params")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".erp-report__params .erp-field--inline")).toMatch(/min-width:\s*1\d\dpx/);
    expect(rule(".erp-report__ranges")).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe("KPI value (T13)", () => {
  it("stays on one line so a sign never separates from its digits", () => {
    expect(rule(".erp-home-kpi__value")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".erp-home-kpi__value")).toMatch(/clamp\(/);
  });
});
