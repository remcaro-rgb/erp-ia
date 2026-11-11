// Number formats of the home screen. Latin American Spanish (`es-419`) is the app's language; its numbers follow the
// Colombian convention the rest of the app shows (dots for thousands, a decimal comma: money is `$ 1.234.567,00`, rule 23),
// where the CLDR `es-419` data would use the Mexican one.

export const numberLocale = (locale: string): string => (locale === "es-419" ? "es-CO" : locale);

export const formatCount = (locale: string, value: number): string => new Intl.NumberFormat(numberLocale(locale)).format(value);

/** `1,9 M`, `38 mil`: tokens and other large counts. */
export const formatCompact = (locale: string, value: number): string =>
  new Intl.NumberFormat(numberLocale(locale), { notation: "compact", maximumFractionDigits: 1 }).format(value);

/** The message arguments of a KPI detail: every number as it is, and as text (`total` and `total_text`) for ICU `{total_text}`. */
export function detailParams(locale: string, params: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = { ...params };
  for (const [key, value] of Object.entries(params)) if (typeof value === "number") out[`${key}_text`] = formatCount(locale, value);
  return out;
}

/** `10:42` (or `10:42:07`) of an instant, on the 24-hour clock of the company's zone (the runtime's when absent). */
export function clockTime(locale: string, at: string | Date, timeZone?: string, seconds = false): string {
  return new Intl.DateTimeFormat(numberLocale(locale), { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).format(new Date(at));
}

/** `1,85`: a quotient with two decimals. */
export const formatRatio = (locale: string, value: number): string =>
  new Intl.NumberFormat(numberLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
