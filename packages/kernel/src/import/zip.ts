import { crc32, inflateRawSync } from "node:zlib";
import { ImportFileError } from "./file-error";

// The uploaded XLSX is never handed to ExcelJS (whose zip reader, JSZip, has its own idea of where entries are and
// inflates them whole). This module reads the zip itself, strictly, inflates every part under a hard bound, and
// rebuilds a fresh archive of stored parts from what it inflated; ExcelJS loads only that rebuilt archive.

/** What a workbook may unpack to, all its parts together (a 25 MB upload can hide far more). */
export const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/** Parts a workbook may have. */
export const MAX_XLSX_ENTRIES = 1_000;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_32 = 0xffffffff;

const malformed = () => new ImportFileError("El archivo no es un libro de Excel (.xlsx) válido: su estructura zip no es coherente");
const tooBig = () => new ImportFileError("El libro de Excel es demasiado grande al descomprimirlo");

export interface ZipPart {
  name: string;
  data: Uint8Array;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

/**
 * The parts of a zip, inflated, read strictly (a file with no end record at all is "not a workbook"; one whose
 * structure is incoherent says so):
 * - one end-of-central-directory record, on a single disk, ending the file, sitting right after the central directory
 *   it describes (`offset + size`);
 * - central records walked by signature from that offset until the signature stops; their number must be the one the
 *   end record states, at most `MAX_XLSX_ENTRIES`, and the walk must end exactly at the end record (no trailing record);
 * - no ZIP64, no encryption, only stored (0) or deflated (8) parts, no duplicate names;
 * - each local header must agree with its central record (signature, method, name, and sizes and CRC unless a data
 *   descriptor follows), and its data must lie before the central directory;
 * - each part is inflated with `maxOutputLength` = what is left of `MAX_XLSX_UNCOMPRESSED_BYTES`, must inflate to
 *   exactly its declared size and CRC.
 * Throws `ImportFileError` otherwise.
 */
export function readZipParts(bytes: Uint8Array): ZipPart[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const notZip = () => new ImportFileError("El archivo no es un libro de Excel (.xlsx) válido");
  if (bytes.byteLength < 22) throw notZip();

  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
    if (u32(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notZip();
  const declaredEntries = u16(eocd + 10);
  const directorySize = u32(eocd + 12);
  const directoryOffset = u32(eocd + 16);
  if (declaredEntries === 0xffff || directorySize === MAX_32 || directoryOffset === MAX_32) throw tooBig();
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== declaredEntries) throw malformed();
  if (eocd + 22 + u16(eocd + 20) !== bytes.byteLength) throw malformed();
  if (directoryOffset + directorySize !== eocd) throw malformed();
  if (declaredEntries > MAX_XLSX_ENTRIES) throw tooBig();

  // 1. The central directory, walked by signature (as other zip readers do) until it stops; nothing is inflated
  //    before the whole directory is known to be coherent.
  interface Record {
    flags: number;
    method: number;
    crc: number;
    compressed: number;
    size: number;
    local: number;
    name: string;
    nameBytes: Uint8Array;
  }
  const records: Record[] = [];
  const names = new Set<string>();
  let declaredTotal = 0;
  let at = directoryOffset;
  while (at + 4 <= eocd && u32(at) === CENTRAL) {
    if (records.length >= MAX_XLSX_ENTRIES) throw tooBig();
    if (at + 46 > eocd) throw malformed();
    const record = {
      flags: u16(at + 8),
      method: u16(at + 10),
      crc: u32(at + 16),
      compressed: u32(at + 20),
      size: u32(at + 24),
      local: u32(at + 42),
      nameBytes: bytes.subarray(at + 46, at + 46 + u16(at + 28)),
      name: "",
    };
    const recordEnd = at + 46 + u16(at + 28) + u16(at + 30) + u16(at + 32);
    if (record.compressed === MAX_32 || record.size === MAX_32 || record.local === MAX_32) throw tooBig();
    if (recordEnd > eocd || u16(at + 34) !== 0 || record.flags & 0x1) throw malformed();
    if (record.method !== 0 && record.method !== 8) throw malformed();
    record.name = new TextDecoder().decode(record.nameBytes);
    if (record.name === "" || names.has(record.name)) throw malformed();
    names.add(record.name);
    declaredTotal += record.size;
    if (declaredTotal > MAX_XLSX_UNCOMPRESSED_BYTES) throw tooBig();
    records.push(record);
    at = recordEnd;
  }
  // The walk must end exactly at the end record (no trailing record), with the number of parts it states.
  if (at !== eocd || records.length !== declaredEntries) throw malformed();

  // 2. Each part: its local header agrees with its central record; it inflates, under what is left of the bound, to
  //    exactly its declared size and CRC.
  let total = 0;
  return records.map((record) => {
    const { local, method, flags, crc, compressed, size, nameBytes } = record;
    if (local + 30 > directoryOffset || u32(local) !== LOCAL) throw malformed();
    if (u16(local + 8) !== method || (u16(local + 6) & 0x8) !== (flags & 0x8)) throw malformed();
    const localNameLength = u16(local + 26);
    if (!sameBytes(bytes.subarray(local + 30, local + 30 + localNameLength), nameBytes)) throw malformed();
    if (!(flags & 0x8) && (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size)) throw malformed();
    const start = local + 30 + localNameLength + u16(local + 28);
    if (start + compressed > directoryOffset) throw malformed();
    const raw = bytes.subarray(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, MAX_XLSX_UNCOMPRESSED_BYTES - total) });
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
        throw malformed();
      }
    }
    if (data.byteLength !== size || crc32(data) !== crc) throw malformed();
    total += data.byteLength;
    return { name: record.name, data };
  });
}

/** A zip of `parts`, all stored (no compression), with no extra fields, comments or data descriptors. */
export function storedZip(parts: readonly ZipPart[]): Uint8Array {
  const encoder = new TextEncoder();
  const named = parts.map((part) => ({ ...part, nameBytes: encoder.encode(part.name), crc: crc32(part.data) }));
  const localSize = named.reduce((sum, p) => sum + 30 + p.nameBytes.byteLength + p.data.byteLength, 0);
  const centralSize = named.reduce((sum, p) => sum + 46 + p.nameBytes.byteLength, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const p of named) {
    offsets.push(at);
    view.setUint32(at, LOCAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint32(at + 14, p.crc, true);
    view.setUint32(at + 18, p.data.byteLength, true);
    view.setUint32(at + 22, p.data.byteLength, true);
    view.setUint16(at + 26, p.nameBytes.byteLength, true);
    out.set(p.nameBytes, at + 30);
    out.set(p.data, at + 30 + p.nameBytes.byteLength);
    at += 30 + p.nameBytes.byteLength + p.data.byteLength;
  }
  const directoryOffset = at;
  named.forEach((p, i) => {
    view.setUint32(at, CENTRAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint32(at + 16, p.crc, true);
    view.setUint32(at + 20, p.data.byteLength, true);
    view.setUint32(at + 24, p.data.byteLength, true);
    view.setUint16(at + 28, p.nameBytes.byteLength, true);
    view.setUint32(at + 42, offsets[i]!, true);
    out.set(p.nameBytes, at + 46);
    at += 46 + p.nameBytes.byteLength;
  });
  view.setUint32(at, EOCD, true);
  view.setUint16(at + 8, named.length, true);
  view.setUint16(at + 10, named.length, true);
  view.setUint32(at + 12, at - directoryOffset, true);
  view.setUint32(at + 16, directoryOffset, true);
  return out;
}

/** The uploaded workbook, read strictly and bounded (`readZipParts`), rebuilt as a fresh stored archive for ExcelJS. */
export const rebuildXlsx = (bytes: Uint8Array): Uint8Array => storedZip(readZipParts(bytes));
