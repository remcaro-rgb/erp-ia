import { createHash } from "node:crypto";

// The phase-1 stand-in for the product-image model: a deterministic SVG made of the description's initials on a
// colour derived from a hash of the text. The real model arrives in phase 5 behind the same process
// (`kernel.ai.image_suggest`), through the AI SDK and `kernel.model_policies` (rule 26); nothing here calls a model.

export interface PlaceholderInput {
  description: string;
  /** Unit of measure code (`94`), shown under the picture when given. */
  uom?: string;
  category?: string;
}

export interface PlaceholderImage {
  bytes: Buffer;
  mimeType: "image/svg+xml";
}

/** Words that do not name the product. */
const STOP_WORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "o", "u", "en", "con", "para", "por", "a"]);

/** Up to two upper-case letters or digits: the first of each of the first two meaningful words; `?` when there are none. */
export function initialsOf(description: string): string {
  const words = description
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word !== "" && !STOP_WORDS.has(word.toLowerCase()));
  const initials = words
    .slice(0, 2)
    .map((word) => [...word][0]!.toLocaleUpperCase("es"))
    .join("");
  return initials === "" ? "?" : initials;
}

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Control characters (C0, DEL, C1) are not valid in XML 1.0 and would make the file unreadable: they become spaces. */
// eslint-disable-next-line no-control-regex
const withoutControls = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/ {2,}/g, " ").trim();

/** A line that fits the picture. */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The picture for a description: the same text always gives the same bytes. */
export function placeholderImage({ description, uom, category }: PlaceholderInput): PlaceholderImage {
  const text = withoutControls(description);
  const hue = createHash("sha256").update(text.toLocaleLowerCase("es")).digest().readUInt16BE(0) % 360;
  const caption = [withoutControls(category ?? ""), withoutControls(uom ?? "") ? `UM ${withoutControls(uom ?? "")}` : undefined].filter(Boolean).join(" · ");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320" role="img" aria-label="${escapeXml(clip(text, 80))}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 30) % 360},40%,22%)"/></linearGradient></defs>` +
    `<rect width="480" height="320" fill="url(#g)"/>` +
    `<circle cx="380" cy="90" r="60" fill="rgba(255,255,255,.08)"/>` +
    `<text x="240" y="190" text-anchor="middle" font-family="Source Sans 3, Arial, sans-serif" font-size="96" font-weight="700" fill="#fff">${escapeXml(initialsOf(text))}</text>` +
    `<text x="40" y="60" font-family="Source Sans 3, Arial, sans-serif" font-size="24" font-weight="700" fill="#fff">${escapeXml(clip(text, 36))}</text>` +
    `<text x="40" y="300" font-family="JetBrains Mono, monospace" font-size="13" fill="rgba(255,255,255,.8)">${escapeXml(clip(caption === "" ? "sugerencia IA" : `${caption} · sugerencia IA`, 60))}</text>` +
    `</svg>`;
  return { bytes: Buffer.from(svg, "utf8"), mimeType: "image/svg+xml" };
}
