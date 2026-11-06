// Tax-inclusive amounts (ported from Serena src/lib/dian/amounts.ts). The pack has one rounding, `round2` of the
// tax engine; Serena's restaurant-only `customerInvoiceAmounts` and tip helpers are not ported (the tax engine
// computes amounts from the tax-exclusive price, and a voluntary tip is a document charge, see xml-builder).
import { round2 } from "../taxes/round";

export { round2 };

export interface InclusiveSplit { gross: number; base: number; tax: number }

/** Splits a tax-inclusive amount into base + tax; base + tax always equals gross. */
export function splitInclusive(gross: number, ratePercent: number): InclusiveSplit {
  const g = round2(gross);
  const base = round2(g / (1 + ratePercent / 100));
  return { gross: g, base, tax: round2(g - base) };
}
