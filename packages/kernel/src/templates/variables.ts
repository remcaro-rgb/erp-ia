import type { Tx } from "../db/client";
import { fileStore } from "../files/store";
import { cellOf, cellText, moneyText } from "../exports/format";
import type { ExportColumn, ExportRow } from "../exports/types";
import { countryPackOf } from "../registry/labels";
import type { EntityDef } from "../registry/entities";

// What a template prints besides its fixed text (entity types spec 2026-11-02 §6): the system variables (the company, the printing user,
// the print date), the record's fields, and on a list the row count and the totals of its money columns. A field reaches the page as
// the printing user sees it (rule 14): the columns come from the caller's field access (`exportColumns`), a hidden field is not among
// them and a masked one is flagged; both print empty, never `••••••`. Values are formatted as on paper: money `$ 1.234.567,00`,
// dates `AAAA/MM/DD`, booleans Sí / No (exports/format.ts, the same rules as the grid's PDF export).

/** The system variables every template may print. */
export const SYSTEM_VARIABLES = [
  "empresa.nombre",
  "empresa.nit",
  "empresa.direccion",
  "empresa.ciudad",
  "empresa.telefono",
  "empresa.logo",
  "usuario.nombre",
  "fecha_impresion",
] as const;
export type SystemVariable = (typeof SYSTEM_VARIABLES)[number];

/** The variables that hold an image (a `data:` URI), for image blocks. */
export const IMAGE_VARIABLES: readonly SystemVariable[] = ["empresa.logo"];

/** The variable of a list's row count. */
export const ROW_COUNT_VARIABLE = "registros";
/** The variable of a list's total of the money column `field`. */
export const totalVariable = (field: string): string => `total.${field}`;

export interface PrintCompany {
  name: string;
  /** The tax id as a document prints it (Colombia: the NIT with its check digit, `900373115-3`). */
  nit: string;
  address: string;
  city: string;
  phone: string;
  /** The logo as a `data:image/…;base64,` URI, or "". */
  logo: string;
}

/** What the variables are resolved from: who prints, when, and which columns of the entity they see. */
export interface PrintContext {
  company: PrintCompany;
  user: { name: string };
  printedAt: Date;
  locale: string;
  timeZone: string;
  /** The caller's columns of the entity (`exportColumns`): hidden fields absent, masked ones flagged. */
  columns: readonly ExportColumn[];
}

const PRINT_DATE: ExportColumn = { field: "fecha_impresion", label: "", type: "datetime" };

function systemVariables(ctx: PrintContext): Record<string, string> {
  return {
    "empresa.nombre": ctx.company.name,
    "empresa.nit": ctx.company.nit,
    "empresa.direccion": ctx.company.address,
    "empresa.ciudad": ctx.company.city,
    "empresa.telefono": ctx.company.phone,
    "empresa.logo": ctx.company.logo,
    "usuario.nombre": ctx.user.name,
    fecha_impresion: cellText(PRINT_DATE, ctx.printedAt, { locale: ctx.locale, timeZone: ctx.timeZone, paper: true }),
  };
}

/** One value of `column` as the page prints it: empty when the caller sees it masked. */
export const printedCell = (column: ExportColumn, value: unknown, ctx: Pick<PrintContext, "locale" | "timeZone">): string =>
  column.masked ? "" : cellText(column, value, { locale: ctx.locale, timeZone: ctx.timeZone, paper: true });

/**
 * The variables of a template printing `data`: one record (its fields by name, every field of the entity the caller does not see
 * empty) or a list of rows (`listVariables`).
 */
export function resolveVariables(ctx: PrintContext, entity: EntityDef, data: ExportRow | readonly ExportRow[]): Record<string, string> {
  if (Array.isArray(data)) return listVariables(ctx, entity, data);
  const record = data as ExportRow;
  const vars: Record<string, string> = systemVariables(ctx);
  for (const field of entity.fields) vars[field.name] = "";
  for (const column of ctx.columns) vars[column.field] = printedCell(column, record[column.field], ctx);
  return vars;
}

/** The variables of a list: the system ones, the row count and the total of every money column the caller may print. */
export function listVariables(ctx: PrintContext, entity: EntityDef, rows: readonly ExportRow[]): Record<string, string> {
  const vars: Record<string, string> = { ...systemVariables(ctx), [ROW_COUNT_VARIABLE]: String(rows.length) };
  for (const field of entity.fields) if (field.type === "money") vars[totalVariable(field.name)] = "";
  for (const column of ctx.columns) {
    if (column.type !== "money" || column.masked) continue;
    let sum = 0;
    for (const row of rows) {
      const cell = cellOf(column, row[column.field]);
      if (cell.type === "number") sum += cell.value;
    }
    vars[totalVariable(column.field)] = moneyText(sum);
  }
  return vars;
}

/** The variable names a template of `entity` and `scope` may print in a variable block. */
export function variableNames(entity: EntityDef, scope: "record" | "list"): Set<string> {
  const names = new Set<string>(SYSTEM_VARIABLES);
  if (scope === "list") {
    names.add(ROW_COUNT_VARIABLE);
    for (const field of entity.fields) if (field.type === "money") names.add(totalVariable(field.name));
  }
  return names;
}

/** The first bytes of each image a logo may be (PNG's signature, JPEG's start of image). */
const IMAGE_MAGIC: Record<string, readonly number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

/** True when `bytes` are an image of `mime` (PNG or JPEG) by their first bytes, not only by the type the upload claimed. */
export function imageBytesMatch(bytes: Uint8Array, mime: string): boolean {
  const magic = IMAGE_MAGIC[mime];
  return magic !== undefined && bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte);
}

/**
 * The active company as a letterhead prints it, read in the caller's transaction: its legal name, its tax id with the check digit the
 * country pack gives it (the bare id without a pack), address, city, phone (`+57 6044441234`) and logo (a PNG or JPEG attachment, as a
 * data URI; "" when there is none or it cannot be read).
 */
export async function loadPrintCompany(tx: Tx): Promise<PrintCompany & { timeZone: string; country: string }> {
  const [row] = await tx<
    { legal_name: string; tax_id: string | null; country_code: string; timezone: string; address_line: string | null; city: string | null; phone_cc: string | null; phone: string | null; logo_path: string | null; logo_mime: string | null }[]
  >`
    select c.legal_name, c.tax_id, c.country_code, c.timezone, c.address_line, c.city, c.phone_cc, c.phone,
           a.storage_path as logo_path, a.mime_type as logo_mime
    from kernel.companies c
    left join kernel.attachments a on a.id = c.logo_attachment_id and a.removed_at is null
    where c.id = kernel.current_company_id()`;
  if (!row) return { name: "", nit: "", address: "", city: "", phone: "", logo: "", timeZone: "UTC", country: "" };
  const pack = countryPackOf(row.country_code);
  const nit = row.tax_id ? (pack?.taxIdText?.(row.tax_id) ?? row.tax_id) : "";
  let logo = "";
  if (row.logo_path && row.logo_mime && IMAGE_MAGIC[row.logo_mime]) {
    try {
      const bytes = await (await fileStore()).get(row.logo_path);
      // Bytes that are not the image they claim to be would break every print: the letterhead goes without them.
      if (imageBytesMatch(bytes, row.logo_mime)) logo = `data:${row.logo_mime};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      // A logo that cannot be read leaves the letterhead without it; the print still goes out.
      logo = "";
    }
  }
  return {
    name: row.legal_name,
    nit,
    address: row.address_line ?? "",
    city: row.city ?? "",
    phone: row.phone ? `+${row.phone_cc ?? "57"} ${row.phone}` : "",
    logo,
    timeZone: row.timezone,
    country: row.country_code,
  };
}

/** The printing user's name (their e-mail when they have none), read in the caller's transaction. */
export async function loadPrintUser(tx: Tx, userId: string): Promise<{ name: string }> {
  const [row] = await tx<{ full_name: string | null; email: string }[]>`select full_name, email from kernel.users where id = ${userId}`;
  return { name: row?.full_name?.trim() || row?.email || "" };
}
