// Money as the design shows it everywhere (rule 23, design §5.8a): `$ 1.234.567,00` (es-CO: dots for thousands,
// a decimal comma, two decimals); inputs edit raw digits. Pure, so grids, forms and exports share it. Another currency prints
// its ISO code with the same digits, `USD 12.500,00` (owner item 129, FX design §10; it extends rule 23).

/** The amount as a number, or null when there is none (null, "", or not a number). Database numerics come as strings. */
function amountOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return Number.isFinite(value) ? value : null;
}

/**
 * `$ 1.234.567,00` for COP; any other currency by its ISO code, `USD 12.500,00`, `EUR 980,50` (item 129). The minus sign goes
 * first (`-$ 1.000,00`, `-USD 1.000,00`). `$` is printed only for COP in a COP company; elsewhere every currency, COP
 * included, is named by its code. "" for no amount.
 */
export function formatMoney(value: number | string | null | undefined, currency = "COP", companyCurrency = "COP"): string {
  const amount = amountOf(value);
  if (amount === null) return "";
  const cents = Math.round(Math.abs(amount) * 100);
  const units = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimals = String(cents % 100).padStart(2, "0");
  const sign = amount < 0 && cents > 0 ? "-" : "";
  const mark = currency === "COP" && companyCurrency === "COP" ? "$" : currency;
  return `${sign}${mark} ${units},${decimals}`;
}

/**
 * Reads an amount as a person types or pastes it: `$ 1.234.567,00`, `1234567,5`, `1.234.567`, `1.5`. A comma followed by
 * one or two digits at the end is the decimal mark, and so is a lone dot followed by one or two digits; other dots and
 * commas group thousands. Null when there is no number.
 */
export function parseMoney(text: string): number | null {
  let s = text.trim().replace(/US\$|[A-Z]{3}|[$\s\u00a0\u20ac]/g, "").replace(/\u2212/g, "-");
  if (s === "") return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  // A single dot followed by one or two digits and no comma is a decimal point (`1.5`); otherwise dots group thousands.
  else if (!/^-?\d+\.\d{1,2}$/.test(s)) s = s.replace(/[.,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** The raw text of an amount while it is edited: digits and a decimal comma, no grouping (`1234567,5`). */
export function moneyEditText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return String(value).replace(".", ",");
}
