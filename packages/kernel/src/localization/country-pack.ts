// Country pack contract (design §5.8). The kernel owns the interface and the registry;
// each pack (packages/localization/<country>) implements it and the app registers it at boot.
// The kernel never imports a pack.

/** DIAN document type codes (design §5.8a). */
export type DocumentType = "11" | "12" | "13" | "21" | "22" | "31" | "41" | "42" | "47" | "48" | "50" | "91";

export type TaxIdResult = { ok: true; normalized: string } | { ok: false; reason: string };

/** Fiscal fields of a party as captured by `core.parties` (design §5.8a). */
export type PartyFiscalInput = {
  personType: "1" | "2";
  documentType: DocumentType;
  /** Stored without DV, dots or spaces. */
  documentNumber: string;
  legalName?: string;
  firstSurname?: string;
  secondSurname?: string;
  firstName?: string;
  otherNames?: string;
  tradeName?: string;
  taxResponsibilities: readonly string[];
  taxScheme: "01" | "04" | "ZA" | "ZZ";
  ciiu?: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  departmentCode?: string;
  municipalityCode?: string;
  addressLine?: string;
  postalCode?: string;
  invoiceEmail?: string;
  supplierEmail?: string;
  /** Calling code without "+" (default "57"). */
  phoneCc?: string;
  phone?: string;
  kind: readonly ("customer" | "supplier" | "employee")[];
};

/** Fiscal fields of a product as captured by `core.products` (design §5.8b). */
export type ProductFiscalInput = {
  sku: string;
  description: string;
  kind: "good" | "service";
  idScheme: "999" | "010" | "001" | "020";
  standardCode?: string;
  brand?: string;
  model?: string;
  uomCode: string;
  ivaRate: "19" | "5" | "0" | "EXC";
  incRate?: "2" | "4" | "8" | "16";
  otherTaxes: readonly string[];
  listPrice: number;
  isFreeSample: boolean;
  referencePriceType?: "1" | "2" | "3";
  referencePrice?: number;
  standardCost?: number;
  trackStock: boolean;
  minStock?: number;
};

/** `errors` = format, length and coherence violations (block the save); `missing` = data required for e-invoicing or exógena (warn, sets dian_status). */
export type PartyValidation = {
  errors: string[];
  missing: string[];
  normalized: PartyFiscalInput & { checkDigit: string | null; legalName: string };
};

export type ProductValidation = {
  errors: string[];
  missing: string[];
  normalized: ProductFiscalInput;
};

export interface CountryPack {
  code: "CO";
  validateTaxId(id: string, type: DocumentType): TaxIdResult;
  documentTypes: DocumentType[];
  defaultCurrency: "COP";
  locale: "es-CO";
  validateParty(input: PartyFiscalInput): PartyValidation;
  validateProduct(input: ProductFiscalInput): ProductValidation;
  // phase 2 adds taxes, sequences, eInvoicing, payroll hooks
}

// Kept on globalThis, like the registry: a workflow step bundle loads this module a second time and must see the
// packs the app registered.
const PACKS_KEY = Symbol.for("erp.kernel.countryPacks");
const packGlobals = globalThis as { [PACKS_KEY]?: Map<string, CountryPack> };
const packs: Map<string, CountryPack> = (packGlobals[PACKS_KEY] ??= new Map<string, CountryPack>());

/** Registers (or replaces) the pack for `pack.code`. Called by the app at boot. */
export function registerCountryPack(pack: CountryPack): void {
  packs.set(pack.code, pack);
}

/** Returns the registered pack; throws for an unknown country. */
export function countryPack(code: string): CountryPack {
  const pack = packs.get(code);
  if (!pack) throw new Error(`unknown country pack: ${code}`);
  return pack;
}
