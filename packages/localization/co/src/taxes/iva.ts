import type { TaxLineInput } from "@erp/kernel";
import { round2 } from "./round";

export const IVA_TAX_CODE = "01";

/** IVA of a line: `null` rate for an excluded product (no tax line at all), 0 for exempt. */
export function lineIva(base: number, rate: TaxLineInput["ivaRate"]): { rate: number | null; amount: number } {
  if (rate === "EXC") return { rate: null, amount: 0 };
  const r = Number(rate);
  return { rate: r, amount: round2((base * r) / 100) };
}
