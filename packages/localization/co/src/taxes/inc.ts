import type { TaxLineInput } from "@erp/kernel";
import { OTHER_TAXES } from "../item-tables";
import { round2 } from "./round";

export const INC_TAX_CODE = "04";

export function lineInc(base: number, rate: TaxLineInput["incRate"]): { rate: number | null; amount: number } {
  if (!rate) return { rate: null, amount: 0 };
  return { rate: Number(rate), amount: round2((base * Number(rate)) / 100) };
}

/** Other taxes (bolsas, ICL, IBUA, ICUI…): a percent of the base, or an amount per unit. A bare code has no rate in the product, so it is 0 and flagged. */
export function lineOtherTaxes(base: number, quantity: number, taxes: NonNullable<TaxLineInput["otherTaxes"]>) {
  return taxes.map((t) => {
    const x = typeof t === "string" ? { code: t } : t;
    if (!OTHER_TAXES.some((o) => o.code === x.code)) throw new Error(`unknown other tax code: ${x.code}`);
    const o = x as { ratePercent?: number; amountPerUnit?: number };
    if (o.ratePercent !== undefined) return { code: x.code, rate: o.ratePercent, amount: round2((base * o.ratePercent) / 100), rateKnown: true };
    if (o.amountPerUnit !== undefined) return { code: x.code, rate: null, amount: round2(quantity * o.amountPerUnit), rateKnown: true };
    return { code: x.code, rate: null, amount: 0, rateKnown: false };
  });
}
