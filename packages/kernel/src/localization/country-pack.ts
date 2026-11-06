// Country pack contract (design §5.8). The kernel owns the interface and the registry;
// each pack (packages/localization/<country>) implements it and the app registers it at boot.
// The kernel never imports a pack.
import type { EInvoiceTransport, SecretStore } from "@erp/infra";

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

// Tax engine contract (phase 2B). Quotes, invoices, notes and the e-invoice XML take their amounts from `computeTaxes`.
export type TaxLineInput = {
  quantity: number;
  unitPrice: number;
  /** Discount as an amount off the line. */
  discount?: number;
  kind?: "good" | "service";
  ivaRate: "19" | "5" | "0" | "EXC";
  incRate?: "2" | "4" | "8" | "16";
  /** Codes of the pack's other-taxes table; a code alone has no known rate, so its amount is 0 and `rateKnown` is false. */
  otherTaxes?: readonly (string | { code: string; ratePercent?: number; amountPerUnit?: number })[];
  isFreeSample?: boolean;
  /** Free samples: price the taxes are computed on. */
  referencePrice?: number;
};
export type PartyTaxProfile = {
  responsibilities: readonly string[];
  personType?: "1" | "2";
  /** Overrides the default (the customer withholds income tax when it is O-13 or O-23). */
  withholdsIncome?: boolean;
  /** Overrides the default (the customer withholds IVA when it is O-13 or O-23). */
  withholdsVat?: boolean;
  /** Percent; ReteICA is estimated only when the municipality's rate is given. */
  reteIcaRate?: number;
};
export type TaxedLine = {
  base: number;
  ivaRate: number | null;
  iva: number;
  incRate: number | null;
  inc: number;
  otherTaxes: { code: string; rate: number | null; amount: number; rateKnown: boolean }[];
  /** Base plus taxes; 0 for a free sample. */
  payable: number;
  freeSample: boolean;
};
export type TaxedDocument = {
  lines: TaxedLine[];
  /** Per tax and rate over the lines that are charged (free samples excluded). */
  taxes: { family: "IVA" | "INC" | "OTHER"; code: string; rate: number | null; base: number; amount: number }[];
  subtotal: number;
  taxTotal: number;
  total: number;
  freeSampleBase: number;
  /** Informational: the customer practises them at payment (accounting design §5.4). */
  withholdingsSuffered: { code: "RTEFTE" | "RTEIVA" | "RTEICA"; concept: string; rate: number; base: number; amount: number }[];
};
export interface TaxesPack {
  rounding: "per_line_half_up_2";
  computeTaxes(input: { lines: TaxLineInput[]; party: PartyTaxProfile; date: string }): TaxedDocument;
  /**
   * The ledger's tax code (`AccountingPack.taxCodes`, the `tax:<code>` dimension of a posting rule) of one entry of `TaxedDocument.taxes`:
   * Colombia's IVA "01" at 19 % is `IVA19`, INC "04" at 8 % is `INC8` (plan 2B Task 16: the invoice event carries the ledger's codes).
   */
  ledgerTaxCode?(tax: TaxedDocument["taxes"][number]): string;
}

// Electronic invoicing contract (plan 2B Task 16): the numbering by the tax authority's resolution and the document's unique code. Server-only
// (the code is a hash: a pack fills it from its server entry, so client bundles never load it); the app registers the pack with it.

/** A numbering resolution as the document prints it (the technical key, input of the unique code, stays inside the pack). */
export interface ResolutionInfo {
  number: string;
  prefix: string;
  from: number;
  to: number;
  validFrom: string;
  validTo: string;
}
/** `no_sequence`: a note's type has no numbering row (Task 18 fix round 1: a note needs a sequence, never a resolution). */
export type DocumentNumberRefusal = "out_of_range" | "expired" | "not_yet_valid" | "no_resolution" | "no_sequence";
/**
 * A drawn number. An invoice's always comes with its resolution and technical key (no valid resolution: `no_resolution`); a credit or debit
 * note's comes from a plain sequence of its type (the tax authority authorizes no range for notes and a note's code takes no technical
 * key), with the resolution only when its row carries one.
 */
export type DrawnDocumentNumber =
  | { ok: true; prefix: string; number: number; full: string; resolution?: ResolutionInfo; technicalKey?: string }
  | { ok: false; code: DocumentNumberRefusal; resolution?: ResolutionInfo };
/** A postgres.js-style transaction (tagged template). */
export type PackTx = (strings: TemplateStringsArray, ...values: never[]) => PromiseLike<readonly Record<string, unknown>[]>;

export interface EInvoicePack {
  /**
   * Draws the next consecutive number of the company's resolution for `type`, valid on `issuedAt`, in the caller's transaction (the
   * increment commits or rolls back with it: a refused issue leaves no gap). Refusals carry the resolution's data.
   */
  nextNumber(tx: PackTx, companyId: string, type: "invoice" | "credit_note" | "debit_note", issuedAt: string): Promise<DrawnDocumentNumber>;
  /** The invoice's unique code (Colombia: CUFE, SHA-384) from its number, date and time, totals, the two tax ids and the resolution's key. */
  invoiceCode(input: {
    number: string;
    issueDate: string;
    /** "HH:mm:ss-05:00". */
    issueTime: string;
    taxed: Pick<TaxedDocument, "subtotal" | "taxes" | "total">;
    /**
     * The tax ids as stored (the pack normalizes them: Colombia drops the check digit and anything that is not a digit of a national
     * document; a foreign document of the customer, by its type, keeps its letters).
     */
    issuerTaxId: string;
    customerTaxId: string;
    /** The customer's document type (absent: the id normalized as a national one, the computation of invoices issued before Task 18's fix round 1). */
    customerDocumentType?: string;
    technicalKey: string;
    environment: "habilitacion" | "produccion";
  }): string;
  /** The payment forms (contado / crédito) and the payment means codes an invoice may carry. */
  paymentForms: readonly string[];
  paymentMeans: readonly string[];
  /**
   * The payment means codes that fit each kind of medio de pago (cash, transfer, card, check, other: payments.method.kind): a method of a
   * kind carries one of them (payments refuses another, means_code_kind_mismatch). A kind absent here is not checked.
   */
  paymentMeansByKind?: Readonly<Record<string, readonly string[]>>;
  /** The payment means of an invoice that names none. */
  defaultPaymentMeans: string;
  /** Whether a customer's tax id (as stored) can be carried by the invoice's code: «Emitir» refuses it otherwise (customer_tax_id_missing). */
  taxIdUsable(taxId: string, documentType?: string): boolean;

  // The submission to the tax authority (plan 2B Task 17): the invoicing workflow builds, signs and sends the document only through these.

  /** The document currencies the electronic document can carry (Colombia: the ISO 4217 codes of DIAN table 13.3.3, Task 18). */
  documentCurrencies: readonly string[];
  /** The electronic invoice (Colombia: UBL 2.1, Anexo Técnico 1.9; national or export) and the unique code it carries, computed again from the document. */
  buildInvoiceXml(doc: EInvoiceDocumentInput): { xml: string; code: string };

  // Credit and debit notes (plan 2B Task 18): their correction concepts and the electronic note.

  /** The correction concepts a credit or a debit note may name (Colombia: DIAN tables 13.2.4 and 13.2.5), with the tax authority's wording. */
  noteConcepts: { credit: readonly { code: string; name: string }[]; debit: readonly { code: string; name: string }[] };
  /** The credit-note concept of an annulment: the note that cancels the whole invoice (Colombia: 2 of table 13.2.4, OD-7). */
  annulmentConcept: string;
  /**
   * The electronic credit or debit note and its unique code (Colombia: CUDE, SHA-384 with the software PIN), computed from the document.
   * Throws when the concept, operation type or currency is not one of the tax authority's.
   */
  buildNoteXml(doc: EInvoiceNoteInput): { xml: string; code: string };
  /** Signs the document with the company's certificate, read through the secrets seam (rule 12); throws when none is stored. */
  signXml(xml: string, secrets: SecretStore, companyId: string): Promise<string>;
  /**
   * The transport to the tax authority the deployment is configured for (the mock unless configured otherwise; design §19, OD-1). With
   * `environment` (the company's DIAN environment) it must serve it: the production guard refuses the mock for a company in producción
   * (Task 19; `einvoice_environment_mismatch`).
   */
  transport(deps: { secrets?: SecretStore | undefined; companyId: string; environment?: "habilitacion" | "produccion" }): EInvoiceTransport;
  /** The production guard on a transport installed by other means (a test's): throws `einvoice_environment_mismatch` when it does not serve `environment`. */
  assertTransportEnvironment(transport: Pick<EInvoiceTransport, "name">, environment: "habilitacion" | "produccion"): void;

  // The Parámetros of electronic invoicing and the document's graphic representation (plan 2B Task 19).

  /** What the PDF of an electronic document prints from the pack. */
  representation: {
    /** The text of the document's QR code (Colombia: the DIAN's query URL of the document by its CUFE / CUDE, on the environment's host). */
    qrPayload(code: string, environment: "habilitacion" | "produccion"): string;
    /** The legend of an invoice's numbering authorization (number, prefix, range, validity) in `locale`. */
    resolutionLegend(resolution: ResolutionInfo, locale: string): string;
  };
  /**
   * Reads a signing certificate (Colombia: PKCS#12 and its password) without storing it. Throws a user-facing error (the caller's
   * language is Spanish) when it is not one or the password does not open it.
   */
  inspectCertificate(file: Uint8Array, password: string): EInvoiceCertificateMeta;
  /** Whether the tax id a certificate names is the company's (Colombia: the NIT, with or without its check digit). */
  certificateHolds(subjectTaxId: string, companyTaxId: string): boolean;
  /**
   * Stores the company's signing certificate and its password through the secrets seam (rule 12; Supabase Vault in production), as one
   * secret `dian/<companyId>/certificate`; answers the SHA-256 of the value stored (the Parámetros keep it: Task 19 fix round 2).
   */
  storeCertificate(secrets: SecretStore, companyId: string, file: Uint8Array, password: string): Promise<{ fingerprint: string }>;
}

/** What may be shown of a signing certificate: who it names, its issuer, serial and validity; never the key or the file. */
export interface EInvoiceCertificateMeta {
  subjectName: string;
  subjectTaxId: string;
  issuer: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  isValid: boolean;
}

/** A party as the electronic document names it: its fiscal fields as stored (core.v_party_fiscal) and its check digit. */
export type EInvoicePartyInput = Pick<PartyFiscalInput, "personType" | "documentType" | "documentNumber" | "taxResponsibilities" | "taxScheme" | "countryCode"> &
  Partial<Pick<PartyFiscalInput, "tradeName" | "departmentCode" | "municipalityCode" | "addressLine" | "postalCode" | "invoiceEmail" | "phoneCc" | "phone">> & {
    legalName: string;
    checkDigit?: string | null;
  };

/** The issuing company as the document names it (its fiscal profile of the invoicing Parámetros); the pack sets its document type. */
export interface EInvoiceIssuer {
  /** Stored without check digit. */
  taxId: string;
  legalName: string;
  tradeName?: string;
  taxResponsibilities: readonly string[];
  taxScheme: PartyFiscalInput["taxScheme"];
  countryCode: string;
  departmentCode?: string;
  municipalityCode?: string;
  addressLine?: string;
  phoneCc?: string;
  phone?: string;
}

/** An issued invoice as the electronic document carries it: what was issued (frozen), the parties, the resolution and the software. */
export interface EInvoiceDocumentInput {
  environment: "habilitacion" | "produccion";
  number: string;
  issueDate: string;
  issueTime: string;
  /** The invoice's resolution with its technical key (the unique code's input). A note has none: its code takes the software PIN. */
  resolution?: ResolutionInfo & { technicalKey: string };
  /** The software registered with the tax authority: its id, its PIN (a secret) and the provider's tax id. */
  software: { id: string; pin: string; providerTaxId: string };
  issuer: EInvoiceIssuer;
  customer: EInvoicePartyInput;
  paymentForm: "1" | "2";
  paymentMeansCode: string;
  dueDate?: string;
  /** One per line of `taxed.lines`, same order. */
  lines: {
    item: Pick<ProductFiscalInput, "sku" | "description" | "idScheme" | "uomCode"> & Partial<Pick<ProductFiscalInput, "standardCode" | "brand" | "model">>;
    quantity: number;
    unitPrice: number;
    discount?: number;
    referencePrice?: number;
    referencePriceType?: "1" | "2" | "3";
  }[];
  taxed: TaxedDocument;
  /** The document currency (ISO 4217; absent: the company's) and, in another currency, the exchange rate of the document and its date. */
  currency?: string;
  exchangeRate?: { rate: number; date: string };
  /** Whether the invoice was issued as an export (frozen at «Emitir»; absent: the pack decides from the customer's country). */
  export?: boolean;
  /**
   * The customer's id reduced to its digits whatever its document type: the computation of an invoice issued before Task 18's fix round 1,
   * so its document carries what its stored code was computed over.
   */
  customerIdDigitsOnly?: boolean;
}

/** An issued credit or debit note as the electronic document carries it: the document of its own lines, its concept and the invoice it corrects. */
export interface EInvoiceNoteInput extends EInvoiceDocumentInput {
  kind: "credit" | "debit";
  /** The correction concept (`noteConcepts`). */
  concept: string;
  /** The invoice it corrects: its number, unique code, date and whether it was an export (the note then follows the export rules). */
  reference: { number: string; code: string; issueDate: string; export: boolean };
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
  /** Taxes and withholdings of the country (phase 2B). */
  taxes: TaxesPack;
  /** Electronic invoicing (plan 2B Task 16): present only where the server registered the pack's server entry. */
  einvoice?: EInvoicePack;
  // phase 2 adds payroll hooks
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
