import type { CodeTable } from "@erp/kernel";
import { DEPARTMENTS, MUNICIPALITIES } from "./dane";
import { DOCUMENT_TYPES } from "./document-types";
import { INC_RATES, ITEM_ID_SCHEMES, IVA_RATES, OTHER_TAXES, PRICE_TYPES, UOM_CODES } from "./item-tables";
import { DIAN_COUNTRY_CODES, TAX_RESPONSIBILITIES, TAX_SCHEMES } from "./tax-tables";

// How a code of the pack's tables reads for a person (the assistant's confirmation cards): DIAN codes keep the code in
// front of the name ("31 · NIT", the grids show them the same way), places and rates read by name.

type Row = { readonly code: string; readonly name: string };

const byCode = (rows: readonly Row[]): Map<string, string> => new Map(rows.map((r) => [r.code, r.name]));

const TABLES: Partial<Record<CodeTable, { names: Map<string, string>; withCode: boolean }>> = {
  documentTypes: { names: byCode(Object.values(DOCUMENT_TYPES)), withCode: true },
  taxSchemes: { names: byCode(TAX_SCHEMES), withCode: true },
  responsibilities: { names: byCode(TAX_RESPONSIBILITIES), withCode: true },
  idSchemes: { names: byCode(ITEM_ID_SCHEMES), withCode: true },
  uoms: { names: byCode(UOM_CODES), withCode: true },
  otherTaxes: { names: byCode(OTHER_TAXES), withCode: true },
  priceTypes: { names: byCode(PRICE_TYPES), withCode: true },
  ivaRates: { names: byCode(IVA_RATES), withCode: false },
  incRates: { names: byCode(INC_RATES), withCode: false },
  departments: { names: byCode(DEPARTMENTS), withCode: false },
  municipalities: { names: byCode(MUNICIPALITIES), withCode: false },
};

const regionNames = new Map<string, Intl.DisplayNames>();
/** A country's name in the reader's language (the grids' and forms' `Intl.DisplayNames`). */
function countryName(code: string, locale: string): string | undefined {
  if (!(code in DIAN_COUNTRY_CODES)) return undefined;
  const language = locale === "en" ? "en" : "es";
  let names = regionNames.get(language);
  if (!names) {
    names = new Intl.DisplayNames([language], { type: "region" });
    regionNames.set(language, names);
  }
  return names.of(code) ?? code;
}

export function codeLabel(table: CodeTable, code: string, locale: string): string | undefined {
  if (table === "countries") return countryName(code, locale);
  const t = TABLES[table];
  const name = t?.names.get(code);
  if (name === undefined) return undefined;
  return t!.withCode ? `${code} · ${name}` : name;
}
