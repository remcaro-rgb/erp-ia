import { inflateSync } from "node:zlib";

/** The strings a PDF prints: every Flate stream inflated, literal and hex strings of the text operators read back (test helper). */
export function pdfText(pdf: Uint8Array): string {
  const bytes = Buffer.from(pdf);
  const out: string[] = [];
  let at = 0;
  const raw = bytes.toString("latin1");
  for (;;) {
    const start = raw.indexOf("stream", at);
    if (start === -1) break;
    const from = raw[start + 6] === "\r" ? start + 8 : start + 7;
    const end = raw.indexOf("endstream", from);
    if (end === -1) break;
    try {
      out.push(inflateSync(bytes.subarray(from, end)).toString("latin1"));
    } catch {
      out.push(raw.slice(from, end));
    }
    at = end + 9;
  }
  const decoded = out.join("\n");
  const hex = [...decoded.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1"));
  const literal = [...decoded.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1]!);
  return [...hex, ...literal].join("");
}

/** The page count a PDF declares (its page tree's /Count). */
export const pageCount = (pdf: Uint8Array): number => Math.max(...[...Buffer.from(pdf).toString("latin1").matchAll(/\/Count (\d+)/g)].map((m) => Number(m[1])));

/** The first page's MediaBox as [width, height]. */
export function mediaBox(pdf: Uint8Array): [number, number] {
  const m = /MediaBox \[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(Buffer.from(pdf).toString("latin1"));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}
