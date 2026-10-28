import type { DocumentType, TaxIdResult } from "@erp/kernel";
import { documentNumberErrors } from "./document-types";

// Official DIAN weights, applied from the rightmost digit (ported from Serena src/lib/dian/nit.ts).
const DV_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/** DIAN modulus-11 check digit (dígito de verificación) of a NIT given without DV. */
export function nitCheckDigit(nitWithoutDv: string): number {
  if (!/^\d{1,15}$/.test(nitWithoutDv)) throw new RangeError("NIT must be 1 to 15 digits");
  let sum = 0;
  for (let i = 0; i < nitWithoutDv.length; i++) {
    sum += Number(nitWithoutDv[nitWithoutDv.length - 1 - i]) * (DV_WEIGHTS[i] as number);
  }
  const r = sum % 11;
  return r > 1 ? 11 - r : r;
}

/**
 * Validates and normalizes a document number. The result is the number as it is stored: without DV,
 * dots or spaces. A NIT may be supplied as "900373115-3"; a DV that does not match the computed one is rejected.
 */
export function validateTaxId(id: string, type: DocumentType): TaxIdResult {
  let number = id;
  let suppliedDv: string | undefined;
  if (type === "31") {
    const dash = id.indexOf("-");
    if (dash >= 0) {
      number = id.slice(0, dash);
      suppliedDv = id.slice(dash + 1);
    }
  }
  const errors = documentNumberErrors(type, number);
  if (errors.length > 0) return { ok: false, reason: errors[0] as string };
  if (suppliedDv !== undefined) {
    if (!/^\d$/.test(suppliedDv)) return { ok: false, reason: "NIT: el dígito de verificación es un solo dígito" };
    const expected = nitCheckDigit(number);
    if (expected !== Number(suppliedDv)) {
      return { ok: false, reason: `El dígito de verificación no coincide (para ${number} es ${expected})` };
    }
  }
  return { ok: true, normalized: number };
}
