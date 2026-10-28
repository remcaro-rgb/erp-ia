import { describe, expect, it } from "vitest";
import { initialsOf, placeholderImage } from "../placeholder";

// The phase-1 stand-in for the image model (rule 26 arrives with phase 5): a deterministic SVG made of the
// description's initials on a colour derived from a hash of the text.

describe("placeholderImage", () => {
  it("draws the initials of the first two words on a coloured background, and names the product and unit", () => {
    const image = placeholderImage({ description: "Café tostado molido 500 g", uom: "94", category: "Café" });
    const svg = image.bytes.toString("utf8");
    expect(image.mimeType).toBe("image/svg+xml");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain(">CT<");
    expect(svg).toMatch(/hsl\(\d{1,3},/);
    expect(svg).toContain("Café tostado molido 500 g");
    expect(svg).toContain("Café");
  });

  it("is deterministic: the same text, the same bytes; another text, another colour", () => {
    const a = placeholderImage({ description: "Prensa francesa 600 ml" });
    expect(placeholderImage({ description: "Prensa francesa 600 ml" }).bytes.equals(a.bytes)).toBe(true);
    const hue = (text: string) => Number(/hsl\((\d+),/.exec(placeholderImage({ description: text }).bytes.toString("utf8"))![1]);
    expect(hue("Prensa francesa 600 ml")).not.toBe(hue("Filtro de papel"));
  });

  it("escapes markup in the description so the file is always well-formed", () => {
    const svg = placeholderImage({ description: `<script>alert("x")</script> & Cía` }).bytes.toString("utf8");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  it("initialsOf takes up to two letters or digits, upper-cased, skipping symbols and short stop words", () => {
    expect(initialsOf("café tostado")).toBe("CT");
    expect(initialsOf("  (Azúcar) de caña  ")).toBe("AC");
    expect(initialsOf("500 g")).toBe("5G");
    expect(initialsOf("Té")).toBe("T");
    expect(initialsOf("***")).toBe("?");
  });
});
