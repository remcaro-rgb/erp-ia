import type { PartyTaxProfile, TaxLineInput, TaxedDocument, TaxedLine } from "@erp/kernel";
import { INC_TAX_CODE, lineInc, lineOtherTaxes } from "./inc";
import { IVA_TAX_CODE, lineIva } from "./iva";
import { round2 } from "./round";
import { withholdingsSuffered } from "./withholdings";

export function computeTaxes(input: { lines: TaxLineInput[]; party: PartyTaxProfile; date: string }): TaxedDocument {
  const lines: TaxedLine[] = [];
  const groups = { compras: { base: 0, iva: 0 }, servicios: { base: 0, iva: 0 } };
  const taxMap = new Map<string, TaxedDocument["taxes"][number]>();
  let subtotal = 0;
  let taxTotal = 0;
  let freeSampleBase = 0;
  const add = (family: "IVA" | "INC" | "OTHER", code: string, rate: number | null, base: number, amount: number) => {
    const key = `${code}|${rate}`;
    const cur = taxMap.get(key) ?? { family, code, rate, base: 0, amount: 0 };
    cur.base = round2(cur.base + base);
    cur.amount = round2(cur.amount + amount);
    taxMap.set(key, cur);
  };

  for (const l of input.lines) {
    const free = l.isFreeSample === true;
    if (free && !(l.referencePrice && l.referencePrice > 0)) throw new Error("free sample line requires a referencePrice > 0 (DIAN prices taxes on it)");
    const base = free ? round2(l.quantity * (l.referencePrice ?? 0)) : round2(l.quantity * l.unitPrice - (l.discount ?? 0));
    const iva = lineIva(base, l.ivaRate);
    const inc = lineInc(base, l.incRate);
    const other = lineOtherTaxes(base, l.quantity, l.otherTaxes ?? []);
    const taxSum = round2(iva.amount + inc.amount + other.reduce((s, o) => s + o.amount, 0));
    lines.push({ base, ivaRate: iva.rate, iva: iva.amount, incRate: inc.rate, inc: inc.amount, otherTaxes: other, payable: free ? 0 : round2(base + taxSum), freeSample: free });
    if (free) {
      freeSampleBase = round2(freeSampleBase + base);
      continue;
    }
    subtotal = round2(subtotal + base);
    taxTotal = round2(taxTotal + taxSum);
    if (iva.rate !== null) add("IVA", IVA_TAX_CODE, iva.rate, base, iva.amount);
    if (inc.rate !== null) add("INC", INC_TAX_CODE, inc.rate, base, inc.amount);
    for (const o of other) add("OTHER", o.code, o.rate, base, o.amount);
    const g = groups[l.kind === "service" ? "servicios" : "compras"];
    g.base = round2(g.base + base);
    g.iva = round2(g.iva + iva.amount);
  }

  return {
    lines,
    taxes: [...taxMap.values()],
    subtotal,
    taxTotal,
    total: round2(subtotal + taxTotal),
    freeSampleBase,
    withholdingsSuffered: withholdingsSuffered(input.party, input.date, groups),
  };
}
