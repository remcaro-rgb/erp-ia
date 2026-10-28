import { crc32, createDeflateRaw, deflateRawSync } from "node:zlib";

// Test fixtures for the XLSX zip checks (exported from `@erp/kernel/testing`): hand-built zips whose records say
// what the test wants, whatever the data really is.

/** One part as it sits in the zip: its stored bytes and what the records declare about it. */
export interface FixturePart {
  name: string;
  method: 0 | 8;
  /** The bytes in the zip (deflate-raw when `method` is 8). */
  payload: Uint8Array;
  /** Declared unpacked size and CRC. */
  size: number;
  crc: number;
  /** The name the local header gives, when it should differ from the central record's. */
  localName?: string;
}

/** An honest part holding `data`, deflated unless `method` is 0. */
export function partOf(name: string, data: Uint8Array, method: 0 | 8 = 8): FixturePart {
  return { name, method, payload: method === 8 ? new Uint8Array(deflateRawSync(data)) : data, size: data.byteLength, crc: crc32(data) };
}

/**
 * A zip of `parts`. `eocdEntries` overrides the part count the end record states; `dataDescriptor` writes the parts the
 * way LibreOffice and streaming writers do (flag bit 3, zero CRC and sizes in the local header, a descriptor after the data).
 */
export function buildZip(parts: readonly FixturePart[], options: { eocdEntries?: number; dataDescriptor?: boolean } = {}): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const flags = options.dataDescriptor ? 0x8 : 0;
  for (const part of parts) {
    const localName = encoder.encode(part.localName ?? part.name);
    const header = new Uint8Array(30 + localName.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, flags, true);
    hv.setUint16(8, part.method, true);
    if (!options.dataDescriptor) {
      hv.setUint32(14, part.crc, true);
      hv.setUint32(18, part.payload.byteLength, true);
      hv.setUint32(22, part.size, true);
    }
    hv.setUint16(26, localName.length, true);
    header.set(localName, 30);
    offsets.push(at);
    chunks.push(header, part.payload);
    at += header.length + part.payload.byteLength;
    if (options.dataDescriptor) {
      const descriptor = new Uint8Array(16);
      const dv = new DataView(descriptor.buffer);
      dv.setUint32(0, 0x08074b50, true);
      dv.setUint32(4, part.crc, true);
      dv.setUint32(8, part.payload.byteLength, true);
      dv.setUint32(12, part.size, true);
      chunks.push(descriptor);
      at += descriptor.length;
    }
  }
  const directoryOffset = at;
  parts.forEach((part, i) => {
    const name = encoder.encode(part.name);
    const record = new Uint8Array(46 + name.length);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, 0x02014b50, true);
    rv.setUint16(4, 20, true);
    rv.setUint16(6, 20, true);
    rv.setUint16(8, flags, true);
    rv.setUint16(10, part.method, true);
    rv.setUint32(16, part.crc, true);
    rv.setUint32(20, part.payload.byteLength, true);
    rv.setUint32(24, part.size, true);
    rv.setUint16(28, name.length, true);
    rv.setUint32(42, offsets[i]!, true);
    record.set(name, 46);
    chunks.push(record);
    at += record.length;
  });
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  const entries = options.eocdEntries ?? parts.length;
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries, true);
  ev.setUint16(10, entries, true);
  ev.setUint32(12, at - directoryOffset, true);
  ev.setUint32(16, directoryOffset, true);
  chunks.push(end);
  const zip = new Uint8Array(at + end.length);
  let offset = 0;
  for (const chunk of chunks) {
    zip.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return zip;
}

/** A one-part zip holding `data` as given (stored, or already deflate-raw), declaring `declaredSize` and a zero CRC. */
export function forgedZip(options: { name?: string; data: Uint8Array; method: 0 | 8; declaredSize: number }): Uint8Array {
  return buildZip([{ name: options.name ?? "xl/worksheets/sheet1.xml", method: options.method, payload: options.data, size: options.declaredSize, crc: 0 }]);
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
