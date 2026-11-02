import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The form's save bar never covers a field: in the flow by default, pinned only on a tall viewport.

const css = readFileSync(join(import.meta.dirname, "..", "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("form save bar", () => {
  it("is not sticky outside the tall-viewport media query", () => {
    const base = /\.erp-form__actions\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(base).not.toMatch(/position:\s*sticky/);
    const tall = /@media \(min-height: 1000px\)\s*\{\s*\.erp-form__actions\s*\{([^}]*)\}/.exec(css);
    expect(tall?.[1]).toMatch(/position:\s*sticky/);
  });
});

describe("record title and tabs", () => {
  it("stop being sticky on a short viewport", () => {
    expect(/@media \(max-height: 640px\)\s*\{\s*\.erp-record__top\s*\{[^}]*position:\s*static/.test(css)).toBe(true);
  });
});
