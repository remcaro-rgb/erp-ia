import type { PartyTaxProfile, TaxedDocument } from "@erp/kernel";
import { round2 } from "./round";

/**
 * UVT by tax year. 2026: $ 52.374, DIAN Resolución 000238 of 2025-12-15 (confirmed against the INCP and actualicese
 * reports of the resolution; verify against the Diario Oficial text before a legal citation). 2025: Res. 000193 of 2024.
 */
export const UVT: Record<number, number> = { 2023: 42412, 2024: 47065, 2025: 49799, 2026: 52374 };

export function uvtFor(date: string): number {
  const year = Number(date.slice(0, 4));
  const v = UVT[year];
  if (!v) throw new Error(`UVT not loaded for ${year}: add it to the Colombia pack table`);
  return v;
}

type Concept = "compras" | "servicios";
/** Retefuente rate by concept (general rates for compras 2,5 % and servicios 4 %; honorarios 10/11 % not modelled: a line is a good or a service). */
const RTEFTE: Record<Concept, { rate: number }> = { compras: { rate: 2.5 }, servicios: { rate: 4 } };
/** Minimum base in UVT. */
const MIN_UVT = { compras: 27, servicios: 4 } as const;
const RTEIVA_RATE = 15;

const isAgent = (p: PartyTaxProfile) => p.responsibilities.includes("O-13") || p.responsibilities.includes("O-23");

/** Withholdings the customer is expected to practise when paying (informational: recognised at collection). */
export function withholdingsSuffered(
  party: PartyTaxProfile,
  date: string,
  groups: Record<Concept, { base: number; iva: number }>,
): TaxedDocument["withholdingsSuffered"] {
  const out: TaxedDocument["withholdingsSuffered"] = [];
  const income = party.withholdsIncome ?? isAgent(party);
  const vat = party.withholdsVat ?? isAgent(party);
  const ica = party.reteIcaRate && party.reteIcaRate > 0 ? party.reteIcaRate : 0;
  // The UVT is read only when a national-threshold withholding can apply, so a non-agent customer never needs the year's UVT.
  const uvt = income || vat ? uvtFor(date) : 0;
  for (const concept of ["compras", "servicios"] as const) {
    const { base, iva } = groups[concept];
    if (base <= 0) continue;
    // ReteICA is municipal: no national UVT threshold, so it is not gated by the retefuente/reteIVA minimum (the caller passes the rate only when it applies).
    if (ica) out.push({ code: "RTEICA", concept, rate: ica, base, amount: round2((base * ica) / 100) });
    if (base < MIN_UVT[concept] * uvt) continue;
    if (income) out.push({ code: "RTEFTE", concept, rate: RTEFTE[concept].rate, base, amount: round2((base * RTEFTE[concept].rate) / 100) });
    if (vat && iva > 0) out.push({ code: "RTEIVA", concept, rate: RTEIVA_RATE, base: iva, amount: round2((iva * RTEIVA_RATE) / 100) });
  }
  return out;
}
