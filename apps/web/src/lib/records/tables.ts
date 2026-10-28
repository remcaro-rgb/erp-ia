import "server-only";
import {
  DEPARTMENTS,
  DIAN_COUNTRY_CODES,
  DOCUMENT_TYPES,
  INC_RATES,
  ITEM_ID_SCHEMES,
  IVA_RATES,
  MUNICIPALITIES,
  NOT_RESPONSIBLE,
  OTHER_TAXES,
  PRICE_TYPES,
  TAX_RESPONSIBILITIES,
  TAX_SCHEMES,
  UOM_CODES,
} from "@erp/loc-co";
import type { PartyTables, ProductTables } from "@erp/ui";
import type { CodeTables } from "@/lib/grid/columns";

// The Colombian pack's code tables as the forms and grids show them (rule 5: the tables and their rules live in
// the pack; the page only hands them over). Lengths are design §5.8a / §5.8b's (the pack checks them on save).

const PARTY_LIMITS = { legalName: 450, namePart: 60, address: 200 } as const;
const ITEM_LIMITS = { sku: 50, description: 300, brand: 100, model: 100 } as const;

/** Country names in the reader's language. */
function countries(locale: string) {
  const names = new Intl.DisplayNames([locale === "en" ? "en" : "es"], { type: "region" });
  return Object.keys(DIAN_COUNTRY_CODES).map((code) => ({ code, name: names.of(code) ?? code }));
}

export function partyTables(locale: string, homeCountry = "CO"): PartyTables {
  return {
    documentTypes: Object.values(DOCUMENT_TYPES).map((d) => ({ code: d.code, name: d.name, charset: d.charset, maxLength: d.maxLength, personTypes: d.personTypes, foreign: d.foreign })),
    responsibilities: TAX_RESPONSIBILITIES.map((r) => ({ code: r.code, name: r.name })),
    exclusiveResponsibility: NOT_RESPONSIBLE,
    taxSchemes: TAX_SCHEMES.map((s) => ({ code: s.code, name: s.name })),
    countries: countries(locale),
    homeCountry,
    departments: DEPARTMENTS,
    municipalities: MUNICIPALITIES,
    // NIT carries the DIAN check digit; a natural person usually shows the cédula, a party abroad its foreign id.
    checkDigitTypes: ["31"],
    preferredDocumentType: { home: { "1": "31", "2": "13" }, abroad: { "1": "50", "2": "41" } },
    limits: PARTY_LIMITS,
  };
}

export function productTables(): ProductTables {
  return {
    idSchemes: ITEM_ID_SCHEMES.map((s) => ({ code: s.code, name: s.name, kind: s.kind, length: s.length, standardCodeLabel: s.standardCodeLabel })),
    uoms: UOM_CODES,
    ivaRates: IVA_RATES.map((r) => ({ code: r.code, name: r.name })),
    incRates: INC_RATES.map((r) => ({ code: r.code, name: r.name })),
    otherTaxes: OTHER_TAXES.map((r) => ({ code: r.code, name: r.name })),
    priceTypes: PRICE_TYPES.map((r) => ({ code: r.code, name: r.name })),
    limits: ITEM_LIMITS,
  };
}

const coded = (rows: readonly { code: string; name: string }[], withCode = true) => rows.map((r) => ({ value: r.code, label: withCode ? `${r.code} · ${r.name}` : r.name }));

/** The code tables the grids show values with (document types, DANE names, taxes…). */
export function gridTables(locale: string): CodeTables {
  return {
    documentTypes: coded(Object.values(DOCUMENT_TYPES)),
    taxSchemes: coded(TAX_SCHEMES),
    countries: coded(countries(locale), false),
    departments: coded(DEPARTMENTS, false),
    municipalities: coded(MUNICIPALITIES, false),
    idSchemes: coded(ITEM_ID_SCHEMES),
    ivaRates: coded(IVA_RATES, false),
    incRates: coded(INC_RATES, false),
  };
}
