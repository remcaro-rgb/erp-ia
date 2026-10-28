// Content verification for uploads (rule 22 hardening). The browser's declared type is a claim; for the
// kinds the admin restricts (pdf, image) the first bytes must agree with it before anything is stored.

export type SniffedMime = "application/pdf" | "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The type the leading bytes prove, or null when they match none of the supported formats. */
export function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF8"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/**
 * Why a file cannot be stored under a tag of `kind`, or null. `kind` pdf needs `%PDF-` bytes and the
 * declared type application/pdf; image needs the bytes of a PNG, JPEG, GIF or WebP and a declared type
 * that names that same format; any (or a free-form tag, null) accepts everything.
 */
export function contentProblem(kind: "pdf" | "image" | "any" | null, declaredMime: string, bytes: Uint8Array): "not_pdf" | "not_image" | null {
  if (kind !== "pdf" && kind !== "image") return null;
  const sniffed = sniffMime(bytes);
  if (kind === "pdf") return sniffed === "application/pdf" && declaredMime === "application/pdf" ? null : "not_pdf";
  return sniffed !== null && sniffed !== "application/pdf" && declaredMime === sniffed ? null : "not_image";
}
