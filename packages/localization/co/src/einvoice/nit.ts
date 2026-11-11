// DIAN identification rules for the e-invoice layer. The check digit algorithm lives once, in ../nit.ts
// (ported from Serena src/lib/dian/nit.ts); this module re-exports it and keeps Serena's lenient
// "NIT o cédula" field validator.
import { nitCheckDigit } from "../nit";

export { nitCheckDigit };

/** Serena's name for the same function, kept so ported callers read unchanged. Accepts dots and dashes noise. */
export function computeNitDv(nit: string): number {
  return nitCheckDigit(nit.replace(/\D/g, ""));
}

export interface NitValidation {
  valid: boolean;
  error?: string;
}

/**
 * "NIT o Cédula" field: accepts a cédula (6-15 digits), a NIT without DV, or NIT-DV ("900123456-7") whose
 * check digit must match.
 */
export function validateNitOrCedula(raw: string): NitValidation {
  const value = raw.replace(/[\s.]/g, "");
  if (!value) return { valid: false, error: "Ingresa tu NIT o cédula" };
  const withDv = /^(\d{5,15})-(\d)$/.exec(value);
  if (withDv) {
    const expected = nitCheckDigit(withDv[1] as string);
    if (expected !== Number(withDv[2])) {
      return { valid: false, error: `El dígito de verificación no coincide (para ${withDv[1]} es ${expected})` };
    }
    return { valid: true };
  }
  if (/^\d{6,15}$/.test(value)) return { valid: true };
  return { valid: false, error: "Solo números, con dígito de verificación opcional (ej: 900123456-7)" };
}
