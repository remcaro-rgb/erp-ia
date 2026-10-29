import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The record frame and its tabs (rule 21, prototype v5): every `erp-*` class their markup uses has a rule in
// components.css, so a tab never renders as unstyled browser defaults (QA round 1: buttons run together, a photo at
// full width, file rows with no spacing).

const src = join(import.meta.dirname, "..", "..");
const css = readFileSync(join(src, "styles", "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const defined = new Set([...css.matchAll(/\.(erp-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]!));

const COMPONENTS = ["record/ContactsTab.tsx", "record/PhotosTab.tsx", "record/ExtraDataTab.tsx", "attachments-panel.tsx", "record/RecordFrame.tsx"];

/** The classes a source names; a template's open end (`erp-pill--${tone}`) reads as its block (`erp-pill`). */
const classesOf = (file: string): string[] => [...new Set([...readFileSync(join(src, file), "utf8").matchAll(/erp-[a-zA-Z0-9_-]*[a-zA-Z0-9]/g)].map((m) => m[0]))];

describe("record tab styles", () => {
  for (const file of COMPONENTS) {
    it(`every erp-* class of ${file} has a rule in components.css`, () => {
      const used = classesOf(file);
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter((c) => !defined.has(c))).toEqual([]);
    });
  }

  it("the tabs have their touch targets and dark theme on the shared tokens", () => {
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/);
    expect(css).toMatch(/\.erp-photos__thumb \{[^}]*width: 96px/);
    expect(css).toMatch(/\.erp-attachments__drop[^{]*\{[^}]*dashed/);
  });
});
