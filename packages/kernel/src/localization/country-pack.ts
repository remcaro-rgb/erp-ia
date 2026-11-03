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

// Accounting pack contract (accounting design §5.9). The kernel owns the shapes; each pack fills them with its chart.

export interface AccountSeed {
  code: string;
  name: string;
  nature: "debit" | "credit";
  requiresParty: boolean;
  requiresInvoiceReady: boolean;
  requiresCostCenter: boolean;
  statementSection?: string;
  isOpeningResult: boolean;
}
export type AccountLevel = "class" | "group" | "account" | "subaccount" | "auxiliary";
export type JournalKind = "general" | "sales" | "purchases" | "receipts" | "payments" | "opening" | "closing";
/** A statement section: `code` is the `statementSection` of the accounts it gathers, `label` an i18n key. */
export interface StatementSection { code: string; label: string }
/** A line of a tax form (formato 2516) that reads the accounts whose code starts with one of `prefixes`. */
export interface LineCode { code: string; label: string; prefixes: string[] }
export interface ExogenaFormat {
  format: string;
  version: number;
  year: number;
  side: "debit" | "credit" | "balance";
  /** Parties whose year total is below this are aggregated under `cuantiasMenoresNit` (accounting design §5.11). */
  threshold: number;
  cuantiasMenoresNit: string;
  concepts: { code: string; label: string }[];
  columns: { id: string; label: string; source: "amount" | "tax:RTEFTE" | "tax:RTEIVA" | "tax:RTEICA" | "base" | "balance" }[];
}
export interface ExogenaRow {
  concept: string;
  partyDocumentType: string;
  partyDocument: string;
  partyDv?: string;
  partyName: string;
  departmentCode?: string;
  municipalityCode?: string;
  countryCode: string;
  /** Whole-peso value per column id of the format. */
  values: Record<string, number>;
}
/** `sentAt` and `shipment` default to the first day after the tax year and the first shipment. */
export interface ExogenaCompany { nit: string; dv: string; name: string; year: number; sentAt?: string; shipment?: number }

export interface AccountingPack {
  chartOfAccounts(): AccountSeed[];
  /** The account each role resolves to by default, with the optional dimension qualifier (design §4.2). */
  defaultRoleMappings(): { role: string; dimension?: string; code: string }[];
  /** Auxiliaries the mappings need and the chart does not list. */
  extraAccounts(): AccountSeed[];
  validateAccountCode(code: string, parentCode?: string): { ok: true; level: AccountLevel } | { ok: false; reason: string };
  fiscalYearFor(date: string): { year: number; startsOn: string; endsOn: string };
  statementLayouts(): { balanceSheet: StatementSection[]; incomeStatement: StatementSection[]; f2516: { esf: LineCode[]; eri: LineCode[] } };
  defaultJournals(): { code: string; name: string; kind: JournalKind; manualEntries: boolean }[];
  taxCodes(): { code: string; family: "IVA" | "INC" | "RTEFTE" | "RTEIVA" | "RTEICA"; rate: number | null; label: string }[];
  defaultConceptMappings(): { format: string; concept: string; code: string }[];
  exogenaFormats(year: number): ExogenaFormat[];
  exogenaXml(format: ExogenaFormat, rows: ExogenaRow[], company: ExogenaCompany): string;
}

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

/**
 * The pack's code tables a field can hold a code of (design §5.8a, §5.8b). Country-neutral names: each pack fills
 * them with its own codes (DIAN tables and DANE for Colombia).
 */
export const CODE_TABLES = [
  "documentTypes",
  "taxSchemes",
  "responsibilities",
  "countries",
  "departments",
  "municipalities",
  "idSchemes",
  "uoms",
  "ivaRates",
  "incRates",
  "otherTaxes",
  "priceTypes",
] as const;
export type CodeTable = (typeof CODE_TABLES)[number];

export interface CountryPack {
  code: "CO";
  validateTaxId(id: string, type: DocumentType): TaxIdResult;
  documentTypes: DocumentType[];
  defaultCurrency: "COP";
  locale: "es-CO";
  validateParty(input: PartyFiscalInput): PartyValidation;
  validateProduct(input: ProductFiscalInput): ProductValidation;
  /**
   * How a code of one of the pack's tables reads for a person (`locale`, `es-419` or `en`): "31 · NIT", "Medellín",
   * "Colombia". A fiscal code keeps the code in front of its name; places read by name. Undefined for an unknown code.
   */
  codeLabel(table: CodeTable, code: string, locale: string): string | undefined;
  /**
   * How the company's own tax id (stored without check digit) prints on a document's letterhead: Colombia's NIT with its check digit,
   * `900373115-3` (PDF templates, entity types spec §6). Without it the bare id prints.
   */
  taxIdText?(taxId: string): string;
  /** The name of the tax id a letterhead prints before it (Colombia: `NIT`). Without it the catalogue's neutral label prints. */
  taxIdLabel?(locale: string): string;
  /** Chart, role mappings, journals, statement layouts, tax codes and exógena of the country (design §5.9). */
  accounting: AccountingPack;
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
