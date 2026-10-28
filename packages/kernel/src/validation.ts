// Contact data validation shared by every module and country pack (rule 11, design §5.16).
// Each function returns null when the value is valid, else a Spanish (es-419) message the UI shows
// next to the field.

/** Calling code assumed when none is given (the default country, rule 5). */
export const DEFAULT_PHONE_CC = "57";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX = 100;

/** `nombre@dominio.ext`, at most 100 characters. */
export function validateEmail(value: string): string | null {
  if (!EMAIL_RE.test(value)) return "Correo inválido (nombre@dominio.ext)";
  if (value.length > EMAIL_MAX) return `Máximo ${EMAIL_MAX} caracteres`;
  return null;
}

/**
 * Phone `number` under calling code `cc` (with or without "+"): digits only; +57 takes 10 digits
 * starting with 3 (celular) or 60 (fijo), or 7 digits; any other code 6 to 14 digits.
 */
export function validatePhone(cc: string, number: string): string | null {
  const code = cc.trim().replace(/^\+/, "");
  if (!/^\d{1,3}$/.test(code)) return "Indicativo de país: 1 a 3 dígitos";
  if (!/^\d+$/.test(number)) return "Solo dígitos, sin espacios ni guiones";
  if (code === DEFAULT_PHONE_CC) {
    const valid = (number.length === 10 && (number.startsWith("3") || number.startsWith("60"))) || number.length === 7;
    return valid ? null : "Colombia: celular 10 dígitos (3…) o fijo 10 dígitos (60…)";
  }
  return number.length < 6 || number.length > 14 ? "6 a 14 dígitos" : null;
}
