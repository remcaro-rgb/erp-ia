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

describe("the general guides' screenshots (entity types Task 17, phase 2B Task 27)", () => {
  it("every image a guide names exists under img/ as a PNG under 300 KB, the 2B chain included", () => {
    const named: string[] = [];
    for (const guide of readdirSync(GUIDES_DIR).filter((name) => name.endsWith(".md"))) {
      const text = readFileSync(join(GUIDES_DIR, guide), "utf8");
      expect(text, guide).not.toMatch(/\[Captura:/);
      for (const match of text.matchAll(/!\[([^\]]+)\]\((img\/[a-z0-9-]+\.png)\)/g)) {
        named.push(match[2]!);
        expect(existsSync(join(GUIDES_DIR, match[2]!)), `${guide}: ${match[2]}`).toBe(true);
        expect(statSync(join(GUIDES_DIR, match[2]!)).size, match[2]).toBeLessThan(300 * 1024);
      }
    }
    for (const image of ["cotizacion-aceptada", "pedido-entregado", "entrega-despachada", "factura-emitida", "recibo-de-caja", "existencias", "capas-de-costo", "condiciones-comerciales"]) {
      expect(named, image).toContain(`img/${image}.png`);
    }
  });
});
