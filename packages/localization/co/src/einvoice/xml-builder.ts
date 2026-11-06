// UBL 2.1 builder for the DIAN electronic invoice and its credit/debit notes (ported from Serena
// src/lib/dian/xml-builder.ts, adapted to the pack's party/product shapes and to `TaxedDocument`).
// Amounts are never recomputed here: lines and totals read the tax engine's result (design §5.17).
import type { PartyFiscalInput, ProductFiscalInput, TaxedDocument, TaxedLine } from "@erp/kernel";
import { municipalityName } from "../dane";
import { ITEM_ID_SCHEMES, OTHER_TAXES, PRICE_TYPES } from "../item-tables";
import { TAX_SCHEMES } from "../tax-tables";
import { round2 } from "../taxes/round";
import { DIAN_AUTH_NIT, SCHEME_AGENCY } from "./constants";
import { computeCude, computeCufe, computeSoftwareSecurityCode, payableAmount } from "./cufe";
import type { Resolution } from "./resolution";
import {
  ANNULMENT_CONCEPT, conceptName, CREDIT_NOTE_OPERATIONS, CURRENCIES, DEBIT_NOTE_OPERATIONS, DOCUMENT_TYPES, EXPORT_CREDIT_NOTE_TYPE, EXPORT_INVOICE_TYPE,
  NATIONAL_CREDIT_NOTE_TYPE, NATIONAL_INVOICE_TYPE,
} from "./tables/dian-tables";

/** A party as the document needs it: the fiscal fields of `core.parties` plus the check digit of its NIT. */
export type EInvoiceParty = Pick<PartyFiscalInput, "personType" | "documentType" | "documentNumber" | "taxResponsibilities" | "taxScheme" | "countryCode"> &
  Partial<Pick<PartyFiscalInput, "tradeName" | "departmentCode" | "municipalityCode" | "addressLine" | "postalCode" | "invoiceEmail" | "phoneCc" | "phone">> & {
    legalName: string;
    /** DV of a NIT (type 31); null/absent for other document types. */
    checkDigit?: string | null;
  };

/** A product as the line needs it (design §5.8b fields). */
export type EInvoiceItem = Pick<ProductFiscalInput, "sku" | "description" | "idScheme" | "uomCode"> & Partial<Pick<ProductFiscalInput, "standardCode" | "brand" | "model">>;

export interface EInvoiceLine {
  item: EInvoiceItem;
  quantity: number;
  /** Tax-exclusive unit price (0 on a free sample). */
  unitPrice: number;
  /** Amount off the line. */
  discount?: number;
  /** Free samples: price the taxes were computed on and its type (table 13.3.10, default "1"). */
  referencePrice?: number;
  referencePriceType?: "1" | "2" | "3";
  /** "Ingresos recibidos para terceros": the owner of the line's income (mandante). */
  thirdParty?: { documentType: string; documentNumber: string; name: string };
}

/**
 * Document-level charge that does not affect the tax base (Anexo FE 1.9): the voluntary tip, third-party income
 * outside the INC/IVA base (E.T. art. 512-9). Raises ChargeTotalAmount and PayableAmount only.
 */
export interface DocumentCharge {
  reason: string;
  /** Percentage applied over baseAmount (0-100). */
  multiplierFactor: number;
  amount: number;
  baseAmount: number;
}

export interface EInvoiceDocument {
  environment: "habilitacion" | "produccion";
  /** Prefix + consecutive, as drawn from the resolution. */
  number: string;
  issueDate: string;
  /** "HH:mm:ss-05:00". */
  issueTime: string;
  /** The invoice's numbering resolution (InvoiceControl, the CUFE's technical key). A note has none (Task 18 fix round 1). */
  resolution?: Resolution | undefined;
  software: { id: string; pin: string; providerNit: string; providerDv: string };
  /** The company (design §5.8a fields). */
  supplier: EInvoiceParty;
  customer: EInvoiceParty;
  /** Table 13.3.4.1: "1" contado, "2" crédito. */
  paymentForm: "1" | "2";
  /** Table 13.3.4.2 (10 efectivo, 42 consignación, 47 transferencia...). */
  paymentMeansCode: string;
  dueDate?: string;
  /** One entry per line of `taxed.lines`, same order. */
  lines: EInvoiceLine[];
  taxed: TaxedDocument;
  charges?: DocumentCharge[];
  /**
   * The document currency (table 13.3.3, ISO 4217; default COP). Every amount is in it, as the invoice was issued and its CUFE computed
   * (plan 2B Task 18: an issued foreign-currency invoice keeps the CUFE «Emitir» gave it).
   */
  currency?: string;
  /** The TRM of a document in another currency than COP: units of COP per unit of `currency`, and its date (cac:PaymentExchangeRate). */
  exchangeRate?: { rate: number; date: string } | undefined;
  /** Whether the invoice was issued as an export, frozen at «Emitir» (absent: a buyer abroad, `isExport`). */
  export?: boolean | undefined;
}

/**
 * Credit or debit note referencing an issued invoice (Anexo 1.9, plan 2B Task 18). `responseCode` is the correction concept of table
 * 13.2.4 (credit) or 13.2.5 (debit); the description defaults to the table's (rule CBF04 rejects one that does not match the code). The
 * operation type (CustomizationID, tables 13.1.5.2 / 13.1.5.3) defaults to the note that references an invoice: 20 credit, 30 debit; the
 * annulment concept (2) requires 20 (rule CAD02a). The CreditNoteTypeCode defaults from the invoice it corrects: 02 for an export
 * invoice (the annex's export validation set, rule CAK19), else 91 (UNCONFIRMED, see tables/dian-tables.ts). A debit note has none (UBL
 * 2.1 DebitNote). The note's currency and TRM are the invoice's (the caller copies them).
 */
export interface EInvoiceNote extends EInvoiceDocument {
  kind: "credit" | "debit";
  responseCode: string;
  customizationId?: string;
  typeCode?: string;
  description?: string;
  /** The invoice: number, CUFE, date and its InvoiceTypeCode (01 national, 02 export; default 01). */
  reference: { number: string; cufe: string; issueDate: string; invoiceTypeCode?: string };
}

/** Builds the document from the tax engine's result, the parties and the company; checks the pieces agree. */
export function assertEInvoiceDocument(doc: EInvoiceDocument): EInvoiceDocument {
  if (doc.lines.length !== doc.taxed.lines.length) throw new Error("e-invoice: lines must match taxed.lines one to one");
  doc.lines.forEach((l, i) => {
    const t = doc.taxed.lines[i] as TaxedLine;
    if (t.freeSample && !(l.referencePrice && l.referencePrice > 0)) throw new Error(`e-invoice: free sample line ${i + 1} needs its referencePrice`);
  });
  return doc;
}

const COMPANY_CURRENCY = "COP";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (n: number): string => n.toFixed(2);
/** An amount element in the document's currency (rule CAD15b / FAD15b: one currency for every @currencyID of the document). */
const money = (cur: string) => (tag: string, n: number): string => `<cbc:${tag} currencyID="${cur}">${amt(n)}</cbc:${tag}>`;
type Money = ReturnType<typeof money>;
const AGENCY = `schemeAgencyID="${SCHEME_AGENCY.id}" schemeAgencyName="${SCHEME_AGENCY.name}"`;
const envCode = (env: EInvoiceDocument["environment"]): string => (env === "produccion" ? "1" : "2");

const NS = (root: "Invoice" | "CreditNote" | "DebitNote") => `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"`;

/** The DIAN extensions: the numbering authorization (InvoiceControl) only on an invoice (the DIAN's 1.9 examples of notes have none). */
function dianExtensions(d: EInvoiceDocument, invoiceControl: boolean): string {
  const r = d.resolution;
  if (invoiceControl && !r) throw new Error("e-invoice: an invoice needs the numbering resolution its InvoiceControl carries");
  return `<ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions>${invoiceControl ? `
          <sts:InvoiceControl>
            <sts:InvoiceAuthorization>${esc(r!.number)}</sts:InvoiceAuthorization>
            <sts:AuthorizationPeriod>
              <cbc:StartDate>${r!.validFrom}</cbc:StartDate>
              <cbc:EndDate>${r!.validTo}</cbc:EndDate>
            </sts:AuthorizationPeriod>
            <sts:AuthorizedInvoices>
              <sts:Prefix>${esc(r!.prefix)}</sts:Prefix>
              <sts:From>${r!.from}</sts:From>
              <sts:To>${r!.to}</sts:To>
            </sts:AuthorizedInvoices>
          </sts:InvoiceControl>` : ""}
          <sts:InvoiceSource>
            <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
          </sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID schemeID="${esc(d.software.providerDv)}" schemeName="31" ${AGENCY}>${esc(d.software.providerNit)}</sts:ProviderID>
            <sts:SoftwareID ${AGENCY}>${esc(d.software.id)}</sts:SoftwareID>
          </sts:SoftwareProvider>
          <sts:SoftwareSecurityCode ${AGENCY}>${computeSoftwareSecurityCode(d.software.id, d.software.pin, d.number)}</sts:SoftwareSecurityCode>
          <sts:AuthorizationProvider>
            <sts:AuthorizationProviderID schemeID="4" schemeName="31" ${AGENCY}>${DIAN_AUTH_NIT}</sts:AuthorizationProviderID>
          </sts:AuthorizationProvider>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>`;
}

const SIGNATURE_PLACEHOLDER = `<ext:UBLExtension>
      <ext:ExtensionContent>
        <!-- SIGNATURE_PLACEHOLDER -->
      </ext:ExtensionContent>
    </ext:UBLExtension>`;

/**
 * A party's address. A party abroad (an export's buyer) has no Colombian address: no DANE municipality or department, only its address
 * line and its country (a stale DANE code of a party that moved abroad is never written: the Anexo refuses a Colombian address in an
 * export, §5.2).
 */
function address(p: EInvoiceParty, tag: "Address" | "RegistrationAddress", withCityName: boolean): string {
  const domestic = p.countryCode === "CO";
  const municipality = domestic ? p.municipalityCode : undefined;
  const department = domestic ? p.departmentCode : undefined;
  if (!p.addressLine && !municipality) return "";
  const city = municipality ? municipalityName(municipality) : undefined;
  return `<cac:${tag}>
          ${municipality ? `<cbc:ID>${esc(municipality)}</cbc:ID>` : ""}
          ${withCityName && city ? `<cbc:CityName>${esc(city)}</cbc:CityName>` : ""}
          ${department ? `<cbc:CountrySubentity>${esc(department)}</cbc:CountrySubentity><cbc:CountrySubentityCode>${esc(department)}</cbc:CountrySubentityCode>` : ""}
          ${p.addressLine ? `<cac:AddressLine><cbc:Line>${esc(p.addressLine)}</cbc:Line></cac:AddressLine>` : ""}
          <cac:Country><cbc:IdentificationCode>${esc(p.countryCode)}</cbc:IdentificationCode></cac:Country>
        </cac:${tag}>`;
}

function location(p: EInvoiceParty): string {
  const a = address(p, "Address", true);
  return a ? `<cac:PhysicalLocation>${a}</cac:PhysicalLocation>` : "";
}

function companyId(p: EInvoiceParty): string {
  // schemeID carries the check digit of a NIT; other document types have none.
  const dv = p.documentType === "31" && p.checkDigit ? `schemeID="${esc(p.checkDigit)}" ` : "";
  return `<cbc:CompanyID ${dv}schemeName="${esc(p.documentType)}" ${AGENCY}>${esc(p.documentNumber)}</cbc:CompanyID>`;
}

function party(p: EInvoiceParty, role: "AccountingSupplierParty" | "AccountingCustomerParty"): string {
  const scheme = TAX_SCHEMES.find((s) => s.code === p.taxScheme) ?? { code: "ZZ", name: "No aplica" };
  const contact = p.invoiceEmail || p.phone
    ? `<cac:Contact>${p.phone ? `<cbc:Telephone>${esc(`${p.phoneCc ?? "57"}${p.phone}`)}</cbc:Telephone>` : ""}${p.invoiceEmail ? `<cbc:ElectronicMail>${esc(p.invoiceEmail)}</cbc:ElectronicMail>` : ""}</cac:Contact>`
    : "";
  return `<cac:${role}>
    <cbc:AdditionalAccountID>${p.personType}</cbc:AdditionalAccountID>
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${esc(p.tradeName || p.legalName)}</cbc:Name>
      </cac:PartyName>
      ${location(p)}
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${esc(p.legalName)}</cbc:RegistrationName>
        ${companyId(p)}
        <cbc:TaxLevelCode listName="48">${p.taxResponsibilities.map(esc).join(";")}</cbc:TaxLevelCode>
        ${address(p, "RegistrationAddress", false)}
        <cac:TaxScheme>
          <cbc:ID>${scheme.code}</cbc:ID>
          <cbc:Name>${scheme.name}</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(p.legalName)}</cbc:RegistrationName>
        ${companyId(p)}
      </cac:PartyLegalEntity>
      ${contact}
    </cac:Party>
  </cac:${role}>`;
}

const TAX_NAMES: Record<string, string> = { "01": "IVA", "04": "INC", ...Object.fromEntries(OTHER_TAXES.map((o) => [o.code, o.name])) };
const taxName = (code: string): string => TAX_NAMES[code] ?? code;

interface Sub { code: string; rate: number | null; base: number; amount: number }

function subtotalXml(s: Sub, m: Money): string {
  return `<cac:TaxSubtotal>
        ${m("TaxableAmount", s.base)}
        ${m("TaxAmount", s.amount)}
        <cac:TaxCategory>
          ${s.rate === null ? "" : `<cbc:Percent>${s.rate.toFixed(2)}</cbc:Percent>`}
          <cac:TaxScheme>
            <cbc:ID>${esc(s.code)}</cbc:ID>
            <cbc:Name>${esc(taxName(s.code))}</cbc:Name>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`;
}

/** One cac:TaxTotal per tax code, its subtotals per rate. Nothing taxable at all reports ZZ "No aplica" at zero. */
function taxTotals(subs: Sub[], base: number, m: Money): string {
  if (subs.length === 0) {
    return `<cac:TaxTotal>
      ${m("TaxAmount", 0)}
      <cac:TaxSubtotal>
        ${m("TaxableAmount", base)}
        ${m("TaxAmount", 0)}
        <cac:TaxCategory><cac:TaxScheme><cbc:ID>ZZ</cbc:ID><cbc:Name>No aplica</cbc:Name></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>`;
  }
  const codes = [...new Set(subs.map((s) => s.code))];
  return codes
    .map((code) => {
      const group = subs.filter((s) => s.code === code);
      const total = round2(group.reduce((a, s) => a + s.amount, 0));
      return `<cac:TaxTotal>
      ${m("TaxAmount", total)}
      ${group.map((g) => subtotalXml(g, m)).join("\n      ")}
    </cac:TaxTotal>`;
    })
    .join("\n  ");
}

function lineSubs(t: TaxedLine): Sub[] {
  const subs: Sub[] = [];
  if (t.ivaRate !== null) subs.push({ code: "01", rate: t.ivaRate, base: t.base, amount: t.iva });
  if (t.incRate !== null) subs.push({ code: "04", rate: t.incRate, base: t.base, amount: t.inc });
  for (const o of t.otherTaxes) subs.push({ code: o.code, rate: o.rate, base: t.base, amount: o.amount });
  return subs;
}

function itemXml(item: EInvoiceItem): string {
  const scheme = ITEM_ID_SCHEMES.find((s) => s.code === item.idScheme);
  if (!scheme) throw new Error(`e-invoice: unknown id scheme ${item.idScheme}`);
  if (scheme.kind !== "own" && !item.standardCode) throw new Error(`e-invoice: item ${item.sku} needs a standardCode for scheme ${scheme.code}`);
  let id: string;
  switch (scheme.code) {
    case "999": id = `<cbc:ID schemeID="999" schemeName="Estándar de adopción del contribuyente">${esc(item.standardCode || item.sku)}</cbc:ID>`; break;
    case "010": id = `<cbc:ID schemeID="010" schemeName="GTIN" schemeAgencyID="9">${esc((item.standardCode as string).padStart(scheme.length, "0"))}</cbc:ID>`; break;
    case "001": id = `<cbc:ID schemeID="001" schemeName="UNSPSC" schemeAgencyID="10">${esc(item.standardCode as string)}</cbc:ID>`; break;
    default: id = `<cbc:ID schemeID="020" schemeName="Partida arancelaria" schemeAgencyID="195">${esc(item.standardCode as string)}</cbc:ID>`;
  }
  return `<cac:Item>
      <cbc:Description>${esc(item.description)}</cbc:Description>
      ${item.brand ? `<cbc:BrandName>${esc(item.brand)}</cbc:BrandName>` : ""}
      ${item.model ? `<cbc:ModelName>${esc(item.model)}</cbc:ModelName>` : ""}
      <cac:SellersItemIdentification>
        <cbc:ID>${esc(item.sku)}</cbc:ID>
      </cac:SellersItemIdentification>
      <cac:StandardItemIdentification>
        ${id}
      </cac:StandardItemIdentification>
    </cac:Item>`;
}

const LINE_TAGS = {
  invoice: { el: "InvoiceLine", qty: "InvoicedQuantity" },
  credit: { el: "CreditNoteLine", qty: "CreditedQuantity" },
  debit: { el: "DebitNoteLine", qty: "DebitedQuantity" },
} as const;

function lineXml(kind: keyof typeof LINE_TAGS, n: number, l: EInvoiceLine, t: TaxedLine, m: Money): string {
  const tag = LINE_TAGS[kind];
  const free = t.freeSample;
  const unit = l.item.uomCode;
  const priceType = l.referencePriceType ?? "1";
  const pricing = free
    ? `<cac:PricingReference>
      <cac:AlternativeConditionPrice>
        ${m("PriceAmount", l.referencePrice as number)}
        <cbc:PriceTypeCode>0${priceType}</cbc:PriceTypeCode>
        <cbc:PriceType>${esc(PRICE_TYPES.find((p) => p.code === priceType)?.name ?? "")}</cbc:PriceType>
      </cac:AlternativeConditionPrice>
    </cac:PricingReference>`
    : "";
  const discount = !free && l.discount && l.discount > 0
    ? `<cac:AllowanceCharge>
      <cbc:ID>1</cbc:ID>
      <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
      <cbc:AllowanceChargeReason>Descuento</cbc:AllowanceChargeReason>
      <cbc:MultiplierFactorNumeric>${amt(round2((l.discount / (l.quantity * l.unitPrice)) * 100))}</cbc:MultiplierFactorNumeric>
      ${m("Amount", l.discount)}
      ${m("BaseAmount", round2(l.quantity * l.unitPrice))}
    </cac:AllowanceCharge>`
    : "";
  const third = l.thirdParty
    ? `
    <cac:InformationContentProviderParty>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${esc(l.thirdParty.documentType)}" schemeName="${esc(l.thirdParty.documentType)}">${esc(l.thirdParty.documentNumber)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${esc(l.thirdParty.name)}</cbc:Name>
      </cac:PartyName>
    </cac:InformationContentProviderParty>`
    : "";
  const subs = lineSubs(t);
  return `<cac:${tag.el}>
    <cbc:ID>${n}</cbc:ID>
    <cbc:${tag.qty} unitCode="${esc(unit)}">${l.quantity}</cbc:${tag.qty}>
    ${m("LineExtensionAmount", free ? 0 : t.base)}${free ? "\n    <cbc:FreeOfChargeIndicator>true</cbc:FreeOfChargeIndicator>" : ""}
    ${pricing}${third}
    ${discount}
    ${taxTotals(subs, t.base, m)}
    ${itemXml(l.item)}
    <cac:Price>
      ${m("PriceAmount", free ? 0 : l.unitPrice)}
      <cbc:BaseQuantity unitCode="${esc(unit)}">1</cbc:BaseQuantity>
    </cac:Price>
  </cac:${tag.el}>`;
}

/** cac:AllowanceCharge blocks for document-level charges (ChargeIndicator=true). */
export function buildDocumentCharges(charges: DocumentCharge[] | undefined, m: Money = money(COMPANY_CURRENCY)): string {
  return (charges ?? [])
    .filter((c) => c.amount > 0)
    .map(
      (c, i) => `<cac:AllowanceCharge>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:ChargeIndicator>true</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>${esc(c.reason)}</cbc:AllowanceChargeReason>
    <cbc:MultiplierFactorNumeric>${c.multiplierFactor.toFixed(2)}</cbc:MultiplierFactorNumeric>
    ${m("Amount", c.amount)}
    ${m("BaseAmount", c.baseAmount)}
  </cac:AllowanceCharge>`,
    )
    .join("\n  ");
}

/**
 * TaxExclusiveAmount: the sum of the charged lines' bases, excluded (no-tax) lines included, so that
 * TaxExclusive + Σ taxes = TaxInclusive and Inclusive + charges = Payable reconcile to the cent. Whether DIAN
 * wants excluded bases in TaxExclusiveAmount is unconfirmed (confirm in habilitación).
 */
const taxExclusive = (taxed: TaxedDocument): number => taxed.subtotal;

function monetaryTotal(d: EInvoiceDocument, tag: "LegalMonetaryTotal" | "RequestedMonetaryTotal", m: Money): string {
  const charges = round2((d.charges ?? []).reduce((s, c) => s + (c.amount > 0 ? c.amount : 0), 0));
  return `<cac:${tag}>
    ${m("LineExtensionAmount", d.taxed.subtotal)}
    ${m("TaxExclusiveAmount", taxExclusive(d.taxed))}
    ${m("TaxInclusiveAmount", d.taxed.total)}${charges > 0 ? `\n    ${m("ChargeTotalAmount", charges)}` : ""}
    ${m("PayableAmount", payableAmount(d))}
  </cac:${tag}>`;
}

function documentSubs(d: EInvoiceDocument): Sub[] {
  return d.taxed.taxes.map((t) => ({ code: t.code, rate: t.rate, base: t.base, amount: t.amount }));
}

/** Validates the document currency (table 13.3.3) and, other than COP, its TRM; answers the amount writer and the exchange-rate block. */
function currencyOf(d: EInvoiceDocument): { cur: string; m: Money; exchange: string } {
  const cur = d.currency ?? COMPANY_CURRENCY;
  if (!CURRENCIES.includes(cur)) throw new Error(`e-invoice: currency ${cur} is not in DIAN table 13.3.3 (ISO 4217)`);
  if (cur === COMPANY_CURRENCY) return { cur, m: money(cur), exchange: "" };
  const x = d.exchangeRate;
  if (!x || !(x.rate > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) throw new Error(`e-invoice: a document in ${cur} needs its TRM (PaymentExchangeRate: rate and date)`);
  // The rate as stored (up to 6 decimals), never rounded to 2: it is the TRM the amounts in COP were computed with.
  const rate = String(Number(x.rate.toFixed(6)));
  const exchange = `<cac:PaymentExchangeRate>
    <cbc:SourceCurrencyCode>${cur}</cbc:SourceCurrencyCode>
    <cbc:SourceCurrencyBaseRate>1.00</cbc:SourceCurrencyBaseRate>
    <cbc:TargetCurrencyCode>${COMPANY_CURRENCY}</cbc:TargetCurrencyCode>
    <cbc:TargetCurrencyBaseRate>1.00</cbc:TargetCurrencyBaseRate>
    <cbc:CalculationRate>${rate}</cbc:CalculationRate>
    <cbc:Date>${x.date}</cbc:Date>
  </cac:PaymentExchangeRate>`;
  return { cur, m: money(cur), exchange };
}

/**
 * The body after the header. The order is UBL 2.1's: an Invoice and a DebitNote put the document charges (AllowanceCharge) before the
 * exchange rate; a CreditNote puts the exchange rate first (PaymentExchangeRate precedes AllowanceCharge in its schema).
 */
function common(d: EInvoiceDocument, kind: keyof typeof LINE_TAGS, totalTag: "LegalMonetaryTotal" | "RequestedMonetaryTotal"): { tail: string; head: string; cur: string } {
  assertEInvoiceDocument(d);
  const { cur, m, exchange } = currencyOf(d);
  const head = `<cbc:LineCountNumeric>${d.lines.length}</cbc:LineCountNumeric>`;
  const charges = buildDocumentCharges(d.charges, m);
  const tail = `${party(d.supplier, "AccountingSupplierParty")}
  ${party(d.customer, "AccountingCustomerParty")}
  <cac:PaymentMeans>
    <cbc:ID>${d.paymentForm}</cbc:ID>
    <cbc:PaymentMeansCode>${esc(d.paymentMeansCode)}</cbc:PaymentMeansCode>${d.dueDate ? `\n    <cbc:PaymentDueDate>${d.dueDate}</cbc:PaymentDueDate>` : ""}
  </cac:PaymentMeans>
  ${kind === "credit" ? `${exchange}\n  ${charges}` : `${charges}\n  ${exchange}`}
  ${taxTotals(documentSubs(d), taxExclusive(d.taxed), m)}
  ${monetaryTotal(d, totalTag, m)}
  ${d.lines.map((l, i) => lineXml(kind, i + 1, l, d.taxed.lines[i] as TaxedLine, m)).join("\n  ")}`;
  return { head, tail, cur };
}

const header = (root: "Invoice" | "CreditNote" | "DebitNote", d: EInvoiceDocument, customization: string, profile: string, uuidName: string, uuid: string) => `<?xml version="1.0" encoding="UTF-8"?>
<${root} ${NS(root)}>
  <ext:UBLExtensions>
    ${dianExtensions(d, root === "Invoice")}
    ${SIGNATURE_PLACEHOLDER}
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>${esc(customization)}</cbc:CustomizationID>
  <cbc:ProfileID>${esc(profile)}</cbc:ProfileID>
  <cbc:ProfileExecutionID>${envCode(d.environment)}</cbc:ProfileExecutionID>
  <cbc:ID>${esc(d.number)}</cbc:ID>
  <cbc:UUID schemeID="${envCode(d.environment)}" schemeName="${uuidName}">${uuid}</cbc:UUID>
  <cbc:IssueDate>${d.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${d.issueTime}</cbc:IssueTime>`;

/**
 * Whether the document is an export (international sale), InvoiceTypeCode 02 of table 13.1.3: what «Emitir» froze on the invoice when the
 * document carries it (Task 18 fix round 1), else a buyer abroad (the issuer is Colombian: this is the Colombian pack).
 */
export const isExport = (d: Pick<EInvoiceDocument, "customer" | "export">): boolean => d.export ?? d.customer.countryCode !== "CO";

/**
 * Factura electrónica de venta (CustomizationID 10, «Estándar» of table 13.1.5.1): national (InvoiceTypeCode 01) or export (02, a buyer
 * abroad), in the invoice's currency with its TRM. The export keeps CustomizationID 10: UNCONFIRMED (the DIAN's 1.9 example
 * Exportacion.xml carries 04, which table 13.1.5.1 of the same toolbox no longer lists).
 */
export function buildInvoiceXml(d: EInvoiceDocument): string {
  const { head, tail, cur } = common(d, "invoice", "LegalMonetaryTotal");
  return `${header("Invoice", d, "10", "DIAN 2.1: Factura Electrónica de Venta", "CUFE-SHA384", computeCufe(d))}
  ${d.dueDate ? `<cbc:DueDate>${d.dueDate}</cbc:DueDate>\n  ` : ""}<cbc:InvoiceTypeCode>${isExport(d) ? EXPORT_INVOICE_TYPE : NATIONAL_INVOICE_TYPE}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  ${head}
  ${tail}
</Invoice>`;
}

/** The note's codes: its concept (tables 13.2.4 / 13.2.5), operation type (13.1.5.2 / 13.1.5.3) and CreditNoteTypeCode (13.1.3), checked. */
export function noteCodes(n: Pick<EInvoiceNote, "kind" | "responseCode" | "customizationId" | "typeCode" | "description" | "reference">): { customizationId: string; typeCode: string | null; description: string } {
  const credit = n.kind === "credit";
  const concept = conceptName(n.kind, n.responseCode);
  if (!concept) throw new Error(`e-invoice: ${n.responseCode} is not a concept of DIAN table ${credit ? "13.2.4 (notas crédito)" : "13.2.5 (notas débito)"}`);
  const customizationId = n.customizationId ?? (credit ? "20" : "30");
  const operations = credit ? CREDIT_NOTE_OPERATIONS : DEBIT_NOTE_OPERATIONS;
  if (!operations.some((o) => o.code === customizationId)) throw new Error(`e-invoice: ${customizationId} is not an operation type of DIAN table ${credit ? "13.1.5.2" : "13.1.5.3"}`);
  if (credit && n.responseCode === ANNULMENT_CONCEPT && customizationId !== "20") throw new Error("e-invoice: rule CAD02a: the annulment concept (2) needs CustomizationID 20, a note that references the invoice");
  const exported = n.reference.invoiceTypeCode === EXPORT_INVOICE_TYPE;
  const typeCode = credit ? (n.typeCode ?? (exported ? EXPORT_CREDIT_NOTE_TYPE : NATIONAL_CREDIT_NOTE_TYPE)) : null;
  if (typeCode !== null && !DOCUMENT_TYPES.some((t) => t.code === typeCode)) throw new Error(`e-invoice: ${typeCode} is not a document type of DIAN table 13.1.3 (rule CAD12a)`);
  return { customizationId, typeCode, description: n.description ?? concept };
}

/** Nota crédito or nota débito referencing an issued invoice, in the invoice's currency and TRM. */
export function buildNoteXml(n: EInvoiceNote): string {
  const credit = n.kind === "credit";
  const kind = credit ? "credit" : "debit";
  const codes = noteCodes(n);
  const { head, tail, cur } = common(n, kind, credit ? "LegalMonetaryTotal" : "RequestedMonetaryTotal");
  const root = credit ? "CreditNote" : "DebitNote";
  const profile = credit ? "DIAN 2.1: Nota Crédito de Factura Electrónica de Venta" : "DIAN 2.1: Nota Débito de Factura Electrónica de Venta";
  return `${header(root, n, codes.customizationId, profile, "CUDE-SHA384", computeCude(n))}${codes.typeCode ? `\n  <cbc:CreditNoteTypeCode>${esc(codes.typeCode)}</cbc:CreditNoteTypeCode>` : ""}
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  ${head}
  <cac:DiscrepancyResponse>
    <cbc:ReferenceID>${esc(n.reference.number)}</cbc:ReferenceID>
    <cbc:ResponseCode>${esc(n.responseCode)}</cbc:ResponseCode>
    <cbc:Description>${esc(codes.description)}</cbc:Description>
  </cac:DiscrepancyResponse>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(n.reference.number)}</cbc:ID>
      <cbc:UUID schemeName="CUFE-SHA384">${n.reference.cufe}</cbc:UUID>
      <cbc:IssueDate>${n.reference.issueDate}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  ${tail}
</${root}>`;
}
