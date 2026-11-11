import { formatMoney } from "@erp/ui";

// How a record's Datos tab shows what the caller's role may not see (rule 14, Task 20 fix round 1), like the grid's masked cells.

export const MASKED = "••••••";

/** An amount as the Datos tab shows it: masked (or null in the masked view) reads as the marker, never «$ 0,00». */
export function moneyText(mode: string | undefined, raw: unknown, currency?: string): string {
  if (mode === "masked" || mode === "hidden" || raw === null || raw === undefined || raw === "") return MASKED;
  return formatMoney(Number(raw), currency);
}
