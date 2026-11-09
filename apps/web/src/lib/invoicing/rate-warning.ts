import { rateText } from "@erp/kernel";
import { rateDiffers } from "@erp/module-invoicing";

// The record's chip of R34-8 (plan 2B.2 Task 34.4, owner item 123): an issued foreign-currency invoice whose frozen rate is more than
// 0,005 % off the TRM of its issue date says so. A warning, never a refusal. Pure, so the screen's rule is unit-tested.

/**
 * The warning text when `rate` (the invoice's exchange_rate column: a number or a numeric string) differs from `trm`; null when it does not,
 * when the TRM is unknown, or when the rate is not readable (a field the role does not see). `text` gets the TRM as `4.123,45`.
 */
export function rateWarning(rate: unknown, trm: number | null, text: (trm: string) => string): string | null {
  const value = typeof rate === "number" ? rate : typeof rate === "string" && /^\d+(\.\d+)?$/.test(rate.trim()) ? Number(rate) : NaN;
  if (trm == null || !Number.isFinite(value) || value <= 0) return null;
  return rateDiffers(value, trm) ? text(rateText(trm)) : null;
}
