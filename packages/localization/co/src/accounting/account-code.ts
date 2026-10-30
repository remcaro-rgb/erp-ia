import type { AccountLevel } from "@erp/kernel";

const LEVEL_OF_LENGTH: Record<number, AccountLevel> = { 1: "class", 2: "group", 4: "account", 6: "subaccount" };

/** Class 1, group 2, account 4, subaccount 6 digits; an auxiliary has 8 or more (accounting design §10 call 2). */
export function validateAccountCode(code: string, parentCode?: string): { ok: true; level: AccountLevel } | { ok: false; reason: string } {
  if (!/^\d+$/.test(code)) return { ok: false, reason: "El código solo lleva dígitos" };
  const level = code.length >= 8 ? "auxiliary" : LEVEL_OF_LENGTH[code.length];
  if (!level) return { ok: false, reason: "El código tiene 1 (clase), 2 (grupo), 4 (cuenta), 6 (subcuenta) o 8 o más (auxiliar) dígitos" };
  if (code[0] === "0") return { ok: false, reason: "La clase va de 1 a 9" };
  if (parentCode !== undefined) {
    if (!code.startsWith(parentCode)) return { ok: false, reason: `El código debe empezar por el de su cuenta madre ${parentCode}` };
    if (code.length <= parentCode.length) return { ok: false, reason: "El código debe ser más largo que el de su cuenta madre" };
  }
  return { ok: true, level };
}
