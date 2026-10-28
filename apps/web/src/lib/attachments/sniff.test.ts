import { describe, expect, it } from "vitest";
import { contentProblem, sniffMime } from "./sniff";

const bytes = (...values: number[]) => Uint8Array.from([...values, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const text = (value: string) => Uint8Array.from([...value].map((c) => c.charCodeAt(0)));

const PDF = text("%PDF-1.7\n");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = text("GIF89a");
const WEBP = Uint8Array.from([...text("RIFF"), 1, 2, 3, 4, ...text("WEBPVP8 ")]);

describe("sniffMime", () => {
  it("recognises pdf, png, jpeg, gif and webp by their first bytes", () => {
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(GIF)).toBe("image/gif");
    expect(sniffMime(WEBP)).toBe("image/webp");
  });

  it("returns null for anything else, for a RIFF that is not WebP and for short input", () => {
    expect(sniffMime(text("MZ\u0090 executable"))).toBeNull();
    expect(sniffMime(Uint8Array.from([...text("RIFF"), 1, 2, 3, 4, ...text("WAVEfmt ")]))).toBeNull();
    expect(sniffMime(text("%PDF"))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
});

describe("contentProblem", () => {
  it("a pdf tag needs real pdf bytes and the pdf type", () => {
    expect(contentProblem("pdf", "application/pdf", PDF)).toBeNull();
    expect(contentProblem("pdf", "application/pdf", PNG)).toBe("not_pdf");
    expect(contentProblem("pdf", "image/png", PDF)).toBe("not_pdf");
    expect(contentProblem("pdf", "application/pdf", text("<html>"))).toBe("not_pdf");
  });

  it("an image tag needs image bytes and a declared type naming the same format", () => {
    expect(contentProblem("image", "image/png", PNG)).toBeNull();
    expect(contentProblem("image", "image/jpeg", JPEG)).toBeNull();
    expect(contentProblem("image", "image/gif", GIF)).toBeNull();
    expect(contentProblem("image", "image/webp", WEBP)).toBeNull();
    expect(contentProblem("image", "image/png", JPEG)).toBe("not_image");
    expect(contentProblem("image", "image/png", PDF)).toBe("not_image");
    expect(contentProblem("image", "application/pdf", PDF)).toBe("not_image");
    expect(contentProblem("image", "image/svg+xml", text("<svg xmlns="))).toBe("not_image");
  });

  it("any kind, or a free-form tag, accepts whatever arrives", () => {
    expect(contentProblem("any", "application/zip", text("PK\u0003\u0004"))).toBeNull();
    expect(contentProblem(null, "text/plain", text("hola"))).toBeNull();
  });
});
