import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 1b task 1 (OD-2, OD-3): the contrast of the tokens is computed from the hex values in tokens.css (WCAG 2.x
// relative luminance, no library), so a palette edit that drops under the threshold fails here.

const styles = join(import.meta.dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = strip(readFileSync(join(styles, "tokens.css"), "utf8"));
const components = strip(readFileSync(join(styles, "components.css"), "utf8"));
const globals = strip(readFileSync(join(styles, "globals.css"), "utf8"));

// The three token blocks: light (`:root`), system dark (`@media … :root:not([data-theme="light"])`), forced dark.
const mediaAt = tokens.indexOf("@media (prefers-color-scheme: dark)");
const forcedAt = tokens.indexOf(':root[data-theme="dark"]');
const shadcnAt = tokens.indexOf(":root {", forcedAt);
const blocks = {
  light: tokens.slice(0, mediaAt),
  dark: tokens.slice(mediaAt, forcedAt),
  forcedDark: tokens.slice(forcedAt, shadcnAt),
};

const hexOf = (block: string, name: string): string => {
  const found = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})\\b`).exec(block);
  if (!found) throw new Error(`${name} has no hex value in its block`);
  return found[1]!.toUpperCase();
};

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("the contrast helper", () => {
  it("gives 21:1 for black on white and 1:1 for a colour on itself", () => {
    expect(ratio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(ratio("#1D4ED8", "#1D4ED8")).toBeCloseTo(1, 5);
  });
});

describe.each([
  ["light", blocks.light],
  ["system dark", blocks.dark],
  ["forced dark", blocks.forcedDark],
] as const)("tokens in %s", (_name, block) => {
  it("the focus ring reaches 3:1 on surface, head, page and accent (WCAG 1.4.11)", () => {
    const ring = hexOf(block, "--focus-ring");
    for (const surface of ["--surface", "--head", "--bg"]) expect(ratio(ring, hexOf(block, surface)), `ring on ${surface}`).toBeGreaterThanOrEqual(3);
    expect(ratio(ring, hexOf(block, "--accent")), "ring on --accent").toBeGreaterThanOrEqual(3);
  });

  it("an input boundary reaches 3:1 on the field's surface (OD-3)", () => {
    expect(ratio(hexOf(block, "--line-input"), hexOf(block, "--surface"))).toBeGreaterThanOrEqual(3);
  });

  it("white text on the primary fill and on its hover fill reaches 4.5:1 (OD-2)", () => {
    expect(ratio("#FFFFFF", hexOf(block, "--primary"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#FFFFFF", hexOf(block, "--primary-h"))).toBeGreaterThanOrEqual(4.5);
  });

  it("link text reaches 4.5:1 on the surface and the head (OD-2)", () => {
    expect(ratio(hexOf(block, "--link"), hexOf(block, "--surface"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hexOf(block, "--link"), hexOf(block, "--head"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the owner's values (OD-2, OD-3)", () => {
  it("dark primary is #2563EB with hover #1D4ED8 in both dark blocks; light stays #1D4ED8 / #1E40AF", () => {
    for (const block of [blocks.dark, blocks.forcedDark]) {
      expect(hexOf(block, "--primary")).toBe("#2563EB");
      expect(hexOf(block, "--primary-h")).toBe("#1D4ED8");
    }
    expect(hexOf(blocks.light, "--primary")).toBe("#1D4ED8");
    expect(hexOf(blocks.light, "--primary-h")).toBe("#1E40AF");
  });

  it("--link is #1D4ED8 in light and #60A5FA in dark; --line-input is #8A94A3 / #6B7686", () => {
    expect(hexOf(blocks.light, "--link")).toBe("#1D4ED8");
    expect(hexOf(blocks.dark, "--link")).toBe("#60A5FA");
    expect(hexOf(blocks.forcedDark, "--link")).toBe("#60A5FA");
    expect(hexOf(blocks.light, "--line-input")).toBe("#8A94A3");
    expect(hexOf(blocks.dark, "--line-input")).toBe("#6B7686");
    expect(hexOf(blocks.forcedDark, "--line-input")).toBe("#6B7686");
  });

  it("dividers keep --line; shadcn's --input follows --line-input; both are Tailwind colours", () => {
    expect(tokens).toMatch(/--input:\s*var\(--line-input\)/);
    expect(hexOf(blocks.light, "--line")).toBe("#D7DBE0");
    expect(globals).toMatch(/--color-link:\s*var\(--link\)/);
    expect(globals).toMatch(/--color-line-input:\s*var\(--line-input\)/);
  });
});

describe("where the tokens are used", () => {
  it("field and input boundaries use --line-input; the link classes use --link", () => {
    for (const selector of [".erp-field input:not([type=\"checkbox\"])", ".erp-grid__filters input", ".erp-lk__input", ".erp-adv select", ".erp-stepup input", ".erp-confirm__stepup input"]) {
      const rule = components.split("\n").find((line) => line.includes(selector) && line.includes("border:"));
      expect(rule, selector).toBeTruthy();
      expect(rule, selector).toMatch(/border:\s*1px solid var\(--line-input\)/);
    }
    for (const selector of [".erp-link {", ".erp-record__open", ".erp-contacts__edit {", ".erp-msg a"]) {
      const rule = components.split("\n").find((line) => line.includes(selector));
      expect(rule, selector).toMatch(/color:\s*var\(--link\)/);
    }
  });

  it("the page area has a dense variant (OD-1): gap 12 px, padding 12 px 16 px; the default keeps v5's 16 / 20 24", () => {
    expect(components).toMatch(/\.erp-main\s*\{[^}]*gap:\s*16px;[^}]*padding:\s*20px 24px/);
    expect(components).toMatch(/\.erp-main\[data-density="tight"\]\s*\{[^}]*gap:\s*12px;[^}]*padding:\s*12px 16px/);
  });
});

describe("brand blue used as text or icon (review fix)", () => {
  const ruleOf = (selector: string) => components.split("\n").find((line) => line.trimStart().startsWith(selector))!;

  it("the lookup magnifier (hover and on) uses --link, which reaches 3:1 on the accent tint and the head", () => {
    for (const selector of [".erp-lk__mag.is-on", ".erp-lk__mag:hover"]) expect(ruleOf(selector), selector).toMatch(/color:\s*var\(--link\)/);
    for (const block of [blocks.light, blocks.dark, blocks.forcedDark]) {
      expect(ratio(hexOf(block, "--link"), hexOf(block, "--accent"))).toBeGreaterThanOrEqual(3);
      expect(ratio(hexOf(block, "--link"), hexOf(block, "--head"))).toBeGreaterThanOrEqual(3);
    }
  });

  it("the avatar initials are white on the primary fill (4.5:1 in every theme), not primary on the tint", () => {
    const rule = ruleOf(".erp-avatar {");
    expect(rule).toMatch(/background:\s*var\(--primary\)/);
    expect(rule).toMatch(/color:\s*#fff/);
    for (const block of [blocks.light, blocks.dark, blocks.forcedDark]) expect(ratio("#FFFFFF", hexOf(block, "--primary"))).toBeGreaterThanOrEqual(4.5);
  });

  it("no rule paints text with the primary fill on a tint or surface any more", () => {
    const offenders = components.split("\n").filter((line) => /[{;\s]color:\s*var\(--primary\)/.test(line));
    expect(offenders).toEqual([]);
  });

  it("the unset drawer hides under 1280 px by CSS alone (no flash before hydration), shows above", () => {
    expect(components).toMatch(/@media \(max-width: 1279px\)\s*\{\s*#erp-assistant\[data-assistant="auto"\]\s*\{\s*display:\s*none\s*!important/);
  });
});
