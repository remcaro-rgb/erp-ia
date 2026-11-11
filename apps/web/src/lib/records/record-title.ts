/**
 * The frame title of a record with no title field value (D16): a comprobante in Borrador reads «Borrador»; past Borrador, without a
 * number, any typed record shows its ID («ID 52»); a record with neither falls back to `fallback` (its UUID).
 */
export function untitledRecordTitle(o: { status: string | undefined; seq: unknown; isEntry: boolean; draftTitle: string; idLabel: string; fallback: string }): string {
  if (o.isEntry && (o.status === undefined || o.status === "draft")) return o.draftTitle;
  if (o.seq !== null && o.seq !== undefined && o.seq !== "") return `${o.idLabel} ${Number(o.seq)}`;
  return o.fallback;
}
