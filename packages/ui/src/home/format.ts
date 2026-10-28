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
