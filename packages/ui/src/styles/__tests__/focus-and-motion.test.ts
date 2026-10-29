import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UI density audit, quick wins 2 and 16 (CSS only over the §19a tokens): a focus ring of ≥ 3:1 on every surface
// (WCAG 1.4.11 / 2.4.13), no animation for readers who ask for reduced motion, and the small contrast and target fixes.

const styles = join(import.meta.dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = strip(readFileSync(join(styles, "tokens.css"), "utf8"));
const globals = strip(readFileSync(join(styles, "globals.css"), "utf8"));
const components = strip(readFileSync(join(styles, "components.css"), "utf8"));

describe("focus ring token", () => {
  it("is #1D4ED8 in light and #60A5FA in both dark blocks; shadcn's ring follows it", () => {
    expect(tokens.match(/--focus-ring:\s*#1D4ED8/g)).toHaveLength(1);
    expect(tokens.match(/--focus-ring:\s*#60A5FA/g)).toHaveLength(2);
    expect(tokens).toMatch(/--ring:\s*var\(--focus-ring\)/);
  });

  it("keeps the v5 brand blue and the layout tokens untouched", () => {
    expect(tokens).toMatch(/--focus:\s*#93C5FD/);
    expect(tokens).toMatch(/--primary:\s*#1D4ED8/);
    expect(tokens).toMatch(/--input:\s*var\(--line\)/);
  });

  it("is a Tailwind colour and the base rule paints it at full strength on every :focus-visible", () => {
    expect(globals).toMatch(/--color-focus-ring:\s*var\(--focus-ring\)/);
    expect(globals).not.toMatch(/outline-ring\/50/);
    expect(globals).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    // the navy bar keeps the light ring (5.74:1 on --bar)
    expect(globals).toMatch(/\[data-bar\] :focus-visible\s*\{[^}]*var\(--focus\)/);
  });

  it("no component outline uses the faint brand blue any more", () => {
    expect(components).not.toMatch(/outline:\s*2px solid var\(--focus\)/);
    expect(components).toMatch(/\.erp-grid__filters input:focus-visible/);
  });
});

describe("reduced motion and the small fixes", () => {
  it("stops animations and transitions when the reader prefers reduced motion", () => {
    expect(globals).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration/);
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\.erp-typing i/);
  });

  it("shows the unsorted glyph at 55 %", () => {
    expect(components).toMatch(/\.erp-grid__unsorted\s*\{\s*opacity:\s*\.55/);
  });

  it("uses tabular figures for confirmation values", () => {
    expect(components).toMatch(/\.erp-confirm__body dd\s*\{[^}]*tabular-nums/);
  });

  it("gives the pager 44 px targets on touch screens", () => {
    expect(components).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.erp-pager button[^}]*height:\s*44px/);
  });
});
