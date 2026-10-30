import { extraFree } from "@erp/kernel";
import { z } from "zod";

// Zod fragments shared by the accounting processes.

export const id = z.uuid();
export { extraFree };

/** The admin-defined extra data of a record (design §5.14): the whole document; the processes validate it against the company's custom fields. */
export const extra = z.record(z.string(), z.unknown()).optional();

/** Keys that would reach into the object prototype instead of naming a data field. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The keys of `extra` to set (`null` removes one), merged into the stored document; not together with `extra`. */
export const extraPatch = z
  .custom<Record<string, unknown>>((raw) => typeof raw === "object" && raw !== null && !Array.isArray(raw) && !Object.keys(raw).some((key) => FORBIDDEN_KEYS.has(key)), {
    message: "extraPatch debe ser un objeto sin las claves __proto__, constructor ni prototype",
  })
  .pipe(z.record(z.string(), z.unknown()))
  .optional();

export const idInput = z.object({ id });
export const idOutput = z.object({ id: z.string() });
/** A consult answers the masked row as it is. */
export const rowOutput = z.looseObject({ id: z.string() });

/** A node or master code: digits, letters and the separators accountants use, no spaces. */
export const nodeCode = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/, "El código solo lleva letras, dígitos, punto, guion y guion bajo");
export const name = z.string().trim().min(1).max(200);
