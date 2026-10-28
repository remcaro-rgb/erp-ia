import { z } from "zod";

// Zod fragments shared by the core processes. The enums mirror the kernel's country-pack input types
// (PartyFiscalInput, ProductFiscalInput); the handlers pass the parsed input to the pack, so a drift
// between these schemas and those types fails the typecheck.

export const id = z.uuid();
export const optionalText = z.string().optional();

/** Free-form extra data (design §5.14); validated against the admin's custom fields in Task 9c. */
export const extra = z.record(z.string(), z.unknown()).optional();

export const documentType = z.enum(["11", "12", "13", "21", "22", "31", "41", "42", "47", "48", "50", "91"]);
export const partyKind = z.enum(["customer", "supplier", "employee"]);
export const taxScheme = z.enum(["01", "04", "ZA", "ZZ"]);
export const ivaRate = z.enum(["19", "5", "0", "EXC"]);
export const incRate = z.enum(["2", "4", "8", "16"]);
export const idScheme = z.enum(["999", "010", "001", "020"]);
export const referencePriceType = z.enum(["1", "2", "3"]);
/** Codes of the additional taxes (DIAN table 13.2.2); the pack checks membership. */
export const otherTaxes = z.array(z.string().regex(/^\d{2}$/));
/** UN/ECE Rec. 20 unit code; the pack checks membership. */
export const uomCode = z.string().regex(/^[A-Z0-9]{1,3}$/);

/** Calling code with or without "+", e.g. "57" or "+57"; stored without "+". */
export const phoneCc = z.string().trim().regex(/^\+?\d{1,3}$/);

/** Accepts "" so an update can clear an optional field. */
export const clearable = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, z.literal("")]);
