import type { TaxedDocument, TaxesPack } from "@erp/kernel";
import { computeTaxes } from "./compute";
import { ROUNDING } from "./round";

export { computeTaxes } from "./compute";
export { ROUNDING, round2 } from "./round";
export { UVT, uvtFor } from "./withholdings";

/** The ledger's tax code of a tax of the engine (accounting/tax-codes.ts): IVA and INC by their rate (`IVA19`, `INC8`), others by code. */
export function ledgerTaxCode(tax: TaxedDocument["taxes"][number]): string {
  if (tax.family === "IVA") return `IVA${tax.rate ?? ""}`;
  if (tax.family === "INC") return `INC${tax.rate ?? ""}`;
  return tax.code;
}

export const taxes: TaxesPack = { rounding: ROUNDING, computeTaxes, ledgerTaxCode };
