/** GS1 mod-10 validation for GTIN-8, -12, -13 and -14 (shorter codes are left-padded to 14 digits). */
export function gtinValid(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.padStart(14, "0").split("").map(Number);
  const sum = digits.slice(0, 13).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === digits[13];
}
