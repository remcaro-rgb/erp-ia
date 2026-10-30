// Pure rules of the tabs of the accounting records (Saldos, Resultados, Cierre): which year and range they open on and how the
// figures add up. The figures arrive from the server per period; the selectors only choose which to show.

export interface PeriodLite {
  id: string;
  number: number;
  year: number;
  startsOn: string;
}

/** The fiscal years the periods belong to, newest first. */
export function yearsOf(periods: readonly PeriodLite[]): number[] {
  return [...new Set(periods.map((p) => p.year))].sort((a, b) => b - a);
}

/** The year a tab opens on: the latest with a figure, else the latest year. */
export function defaultYear(periods: readonly PeriodLite[], withFigures: ReadonlySet<string>): number | null {
  const years = yearsOf(periods);
  return years.find((y) => periods.some((p) => p.year === y && withFigures.has(p.id))) ?? years[0] ?? null;
}

/** The periods of `year`, oldest first. */
export function periodsOfYear(periods: readonly PeriodLite[], year: number | null): PeriodLite[] {
  return periods.filter((p) => p.year === year).sort((a, b) => a.startsOn.localeCompare(b.startsOn));
}

/** The periods from `fromId` to `toId` inclusive, whichever comes first. */
export function periodRange(periods: readonly PeriodLite[], fromId: string, toId: string): PeriodLite[] {
  const ordered = [...periods].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const a = ordered.findIndex((p) => p.id === fromId);
  const b = ordered.findIndex((p) => p.id === toId);
  if (a < 0 || b < 0) return [];
  return ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export interface AccountMovement {
  periodId: string;
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
}

export interface AccountNet {
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
  net: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Saldos por cuenta: debit, credit and net (debit − credit) per account over the chosen periods, by code. */
export function netByAccount(rows: readonly AccountMovement[], periodIds: ReadonlySet<string>): AccountNet[] {
  const byAccount = new Map<string, AccountNet>();
  for (const r of rows) {
    if (!periodIds.has(r.periodId)) continue;
    const current = byAccount.get(r.accountId) ?? { accountId: r.accountId, code: r.code, name: r.name, debit: 0, credit: 0, net: 0 };
    current.debit = cents(current.debit + r.debit);
    current.credit = cents(current.credit + r.credit);
    current.net = cents(current.debit - current.credit);
    byAccount.set(r.accountId, current);
  }
  return [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** The figures a recorded close check carries, as `name: value` (amounts the check compares are money, the rest plain). */
const MONEY_KEYS = new Set(["ledger", "open", "difference", "mapped", "balance", "net", "stock"]);
export function checkFigures(value: Record<string, unknown>, money: (n: number) => string): { key: string; text: string }[] {
  return Object.entries(value)
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    .map(([key, v]) => ({ key, text: typeof v === "number" && MONEY_KEYS.has(key) ? money(v) : String(v) }));
}
