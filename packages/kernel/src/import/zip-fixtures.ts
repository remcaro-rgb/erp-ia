import { createDeflateRaw } from "node:zlib";

// Test fixtures for the XLSX size checks (exported from `@erp/kernel/testing`): hand-built zips whose central
// directory says what the test wants, whatever the data really inflates to.

/** A one-part zip holding `data` (stored, or already deflate-raw compressed), declaring `declaredSize` unpacked bytes. */
export function forgedZip(options: { name?: string; data: Uint8Array; method: 0 | 8; declaredSize: number }): Uint8Array {
  const name = new TextEncoder().encode(options.name ?? "xl/worksheets/sheet1.xml");
  const { data, method, declaredSize } = options;
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, method, true);
  lv.setUint32(18, data.byteLength, true);
  lv.setUint32(22, declaredSize, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, method, true);
  cv.setUint32(20, data.byteLength, true);
  cv.setUint32(24, declaredSize, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + data.byteLength, true);
  const zip = new Uint8Array(local.length + data.byteLength + central.length + end.length);
  zip.set(local, 0);
  zip.set(data, local.length);
  zip.set(central, local.length + data.byteLength);
  zip.set(end, local.length + data.byteLength + central.length);
  return zip;
}

/** Deflate-raw of `size` zero bytes, produced 1 MB at a time: the test never holds the inflated size in memory. */
export async function deflatedZeros(size: number): Promise<Uint8Array> {
  const chunk = Buffer.alloc(1024 * 1024);
  const deflate = createDeflateRaw({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (part: Buffer) => parts.push(part));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });
  for (let written = 0; written < size; written += chunk.length) {
    const piece = Math.min(chunk.length, size - written) === chunk.length ? chunk : chunk.subarray(0, size - written);
    if (!deflate.write(piece)) await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  return new Uint8Array(Buffer.concat(parts));
}
