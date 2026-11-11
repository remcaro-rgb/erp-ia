// The price date of a Borrador (owner item 17, plan 2B.2 Task 50.17): the day its prices were set. «Emitir» keeps the prices, so the draft
// warns when they are from another day than today; the user answers with «Recalcular precios». Pure, so the screen's rule is unit-tested.

/** The ISO day (YYYY-MM-DD) of a date column value (a Date or a string), or null when there is none. */
function isoDay(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

/**
 * The warning text when the draft's price date differs from the company's today; null when it is today or unknown (a field the role does
 * not see, a row from before the column). `text` gets the price date as `YYYY/MM/DD`.
 */
export function priceDateWarning(priceDate: unknown, today: string, text: (date: string) => string): string | null {
  const day = isoDay(priceDate);
  if (!day || day === today.slice(0, 10)) return null;
  return text(day.replaceAll("-", "/"));
}
