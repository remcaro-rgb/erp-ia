import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDES_DIR } from "../help-index";

// Screenshots in the accounting guides (gaps Task 10): no `[Captura: …]` placeholder is left and every image a guide names
// exists under the module's img/ folder, as a PNG under 300 KB. The images are refreshed with `pnpm -F web guide:shots`.

const folder = join(GUIDES_DIR, "contabilidad");
const guides = readdirSync(folder).filter((name) => name.endsWith(".md"));

describe("the accounting guides' screenshots", () => {
  it("no guide keeps a [Captura: …] placeholder and every image a guide names exists under its img/ folder", () => {
    expect(guides.length).toBeGreaterThan(0);
    const named: string[] = [];
    for (const guide of guides) {
      const text = readFileSync(join(folder, guide), "utf8");
      expect(text, guide).not.toMatch(/\[Captura:/);
      for (const match of text.matchAll(/!\[([^\]]+)\]\((img\/[a-z0-9-]+\.png)\)/g)) {
        named.push(match[2]!);
        expect(existsSync(join(folder, match[2]!)), `${guide}: ${match[2]}`).toBe(true);
        expect(statSync(join(folder, match[2]!)).size, match[2]).toBeLessThan(300 * 1024);
      }
    }
    expect(named).toHaveLength(15);
    expect(new Set(named).size).toBe(15);
  });
});
