import type { ExchangeRatesPack, OfficialRate } from "@erp/kernel";
import type { RateFeed } from "@erp/infra";

// Colombia's official exchange rate (plan 2B.2 Task 34.1, FX §2; Decreto 1453 de 2018, art. 288 ET: initial recognition at the TRM). The
// Tasa Representativa del Mercado that the Superintendencia Financiera certifies, read from the open-data dataset 32sa-8pi3 of
// datos.gov.co (fields `valor`, `vigenciadesde`, `vigenciahasta`). The TRM is quoted for USD only; any other currency has no official rate
// here (owner item 122: manual rates). A TRM certified on a Friday is valid Saturday to Monday, so one row covers several days.

/** The datos.gov.co dataset of the TRM. */
export const TRM_DATASET = "32sa-8pi3";
const RESOURCE = `https://www.datos.gov.co/resource/${TRM_DATASET}.json`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The query for the TRM valid on `date` (YYYY-MM-DD): the row whose validity covers the date, the most recent first. */
export function trmUrl(date: string): string {
  if (!DAY.test(date)) throw new Error(`trmUrl: ${date} is not a YYYY-MM-DD date`);
  const day = `${date}T00:00:00.000`;
  const where = `vigenciadesde <= '${day}' AND vigenciahasta >= '${day}'`;
  return `${RESOURCE}?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent("vigenciadesde DESC")}&$limit=1`;
}

/** One dataset row as the rate and its validity (dates without time); a malformed row throws. */
export function parseTrmRow(row: unknown): OfficialRate {
  const r = (row ?? {}) as { valor?: unknown; vigenciadesde?: unknown; vigenciahasta?: unknown };
  const rate = Number(r.valor);
  const from = typeof r.vigenciadesde === "string" ? r.vigenciadesde.slice(0, 10) : "";
  const to = typeof r.vigenciahasta === "string" ? r.vigenciahasta.slice(0, 10) : "";
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`TRM row has no valid valor: ${JSON.stringify(row)}`);
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw new Error(`TRM row has no valid validity range: ${JSON.stringify(row)}`);
  return { rate, validFrom: from, validTo: to };
}

export const exchangeRates: ExchangeRatesPack = {
  officialCurrencies: ["USD"],
  async officialRate(currency: string, date: string, feed: RateFeed): Promise<OfficialRate | null> {
    if (currency !== "USD") return null;
    const answer = await feed.getJson(trmUrl(date));
    if (!Array.isArray(answer)) throw new Error(`TRM source answered something other than a list for ${date}`);
    if (answer.length === 0) return null;
    return parseTrmRow(answer[0]);
  },
};
