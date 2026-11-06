import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaxLineInput } from "@erp/kernel";
import { computeCude, computeCufe } from "../einvoice/cufe";
import { einvoicePack } from "../einvoice/pack";
import { buildInvoiceXml, buildNoteXml, type EInvoiceDocument, type EInvoiceItem, type EInvoiceNote, type EInvoiceParty } from "../einvoice/xml-builder";
import { computeTaxes } from "../taxes";
import { validateParty } from "../validate-party";

// Credit and debit notes, the annulment credit note (OD-7: concept 2 of table 13.2.4, CustomizationID 20, the invoice's CUFE in
// BillingReference) and the export invoice (InvoiceTypeCode 02, its currency and TRM, a foreign buyer without a Colombian address) with its
// annulment (CreditNoteTypeCode 02, same currency and TRM). Golden files under fixtures/einvoice: `UPDATE_GOLDEN=1` rewrites them; a diff
// is a reviewed change of the document the DIAN receives.

const golden = (name: string, xml: string) => {
  const url = new URL(`./fixtures/einvoice/${name}`, import.meta.url);
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(url, xml);
  expect(xml).toBe(readFileSync(url, "utf8"));
};

const SUPPLIER: EInvoiceParty = {
  personType: "1", documentType: "31", documentNumber: "900373115", checkDigit: "3", legalName: "Café del Norte S.A.S.", tradeName: "Café del Norte",
  taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO", departmentCode: "05", municipalityCode: "05001", addressLine: "Calle 10 # 5-20",
  invoiceEmail: "facturas@cafedelnorte.co",
};
const NATIONAL: EInvoiceParty = {
  personType: "1", documentType: "31", documentNumber: "860002964", checkDigit: "4", legalName: "Distribuidora Andina S.A.S.",
  taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
};
/** A buyer abroad: NIT de otro país (50), no DANE department or municipality, its address abroad. */
const FOREIGN: EInvoiceParty = {
  personType: "1", documentType: "50", documentNumber: "987654321", checkDigit: null, legalName: "Green Beans Imports LLC",
  taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "US", addressLine: "100 Main St, Portland OR 97201", invoiceEmail: "ap@greenbeans.example",
};
const RESOLUTION = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: "2026-01-01", validTo: "2026-12-31", technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c" };
const NOTE_RESOLUTION = { number: "18760000002", prefix: "NC", from: 1, to: 9999, validFrom: "2026-01-01", validTo: "2026-12-31", technicalKey: "nota-credito-sin-clave" };
const SOFTWARE = { id: "software-uuid-here", pin: "12345", providerNit: "900373115", providerDv: "3" };
const ITEM: EInvoiceItem = { sku: "CAF-500", description: "Café de exportación 500 g", idScheme: "999", uomCode: "94", brand: "Café del Norte", model: "Excelso" };

type Line = TaxLineInput & { item: EInvoiceItem };
function invoice(customer: EInvoiceParty, lines: Line[], over: Partial<EInvoiceDocument> = {}): EInvoiceDocument {
  const taxed = computeTaxes({ lines, party: { responsibilities: customer.taxResponsibilities, personType: customer.personType }, date: "2026-10-30" });
  return {
    environment: "habilitacion", number: "SETP990000007", issueDate: "2026-10-30", issueTime: "10:15:00-05:00", resolution: RESOLUTION, software: SOFTWARE,
    supplier: SUPPLIER, customer, paymentForm: "2", paymentMeansCode: "10", dueDate: "2026-11-29",
    lines: lines.map((l) => ({ item: l.item, quantity: l.quantity, unitPrice: l.unitPrice })), taxed, ...over,
  };
}
/** The full credit note of annulment of `inv`: its lines and taxes as issued, concept 2. */
function annulment(inv: EInvoiceDocument, over: Partial<EInvoiceNote> = {}): EInvoiceNote {
  return {
    ...inv, number: "NC12", issueDate: "2026-11-01", issueTime: "08:00:00-05:00", resolution: NOTE_RESOLUTION, kind: "credit", responseCode: "2",
    reference: { number: inv.number, cufe: computeCufe(inv), issueDate: inv.issueDate, invoiceTypeCode: inv.customer.countryCode === "CO" ? "01" : "02" }, ...over,
  };
}

const national = () => invoice(NATIONAL, [{ item: ITEM, quantity: 3, unitPrice: 20000, ivaRate: "19" }]);
/** An export: a good sold abroad is IVA exento at 0 % (E.T. art. 481), billed in USD at the TRM of the day. */
const exportUsd = () => invoice(FOREIGN, [{ item: ITEM, quantity: 100, unitPrice: 12.5, ivaRate: "0" }], { currency: "USD", exchangeRate: { rate: 4123.4567, date: "2026-10-30" } });

describe("the annulment credit note (OD-7)", () => {
  it("carries ResponseCode 2 with the table's description, CustomizationID 20, CreditNoteTypeCode 91 and the invoice's CUFE in BillingReference", () => {
    const inv = national();
    const note = annulment(inv);
    const xml = buildNoteXml(note);
    expect(xml).toContain("<cbc:CustomizationID>20</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode>");
    expect(xml).toMatch(/<cac:DiscrepancyResponse>\s*<cbc:ReferenceID>SETP990000007<\/cbc:ReferenceID>\s*<cbc:ResponseCode>2<\/cbc:ResponseCode>\s*<cbc:Description>Anulación de factura electrónica<\/cbc:Description>/);
    expect(xml).toMatch(new RegExp(`<cac:InvoiceDocumentReference>\\s*<cbc:ID>SETP990000007</cbc:ID>\\s*<cbc:UUID schemeName="CUFE-SHA384">${computeCufe(inv)}</cbc:UUID>\\s*<cbc:IssueDate>2026-10-30</cbc:IssueDate>`));
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUDE-SHA384">${computeCude(note)}</cbc:UUID>`);
    // A note carries no numbering authorization (the DIAN's 1.9 examples of notes have no InvoiceControl).
    expect(xml).not.toContain("<sts:InvoiceControl>");
    expect(xml).toContain("<cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>");
    expect(xml).not.toContain("PaymentExchangeRate");
    golden("annulment-credit-note.xml", xml);
  });

  it("refuses the annulment concept with an operation type other than 20 (rule CAD02a), and an unknown concept", () => {
    expect(() => buildNoteXml(annulment(national(), { customizationId: "22" }))).toThrow(/CAD02a/);
    expect(() => buildNoteXml(annulment(national(), { responseCode: "9" }))).toThrow(/13\.2\.4/);
    expect(() => buildNoteXml(annulment(national(), { kind: "debit", responseCode: "5" }))).toThrow(/13\.2\.5/);
  });

  it("a debit note takes CustomizationID 30 and its concept from table 13.2.5", () => {
    const xml = buildNoteXml(annulment(national(), { kind: "debit", responseCode: "1", number: "ND3" }));
    expect(xml).toContain("<cbc:CustomizationID>30</cbc:CustomizationID>");
    expect(xml).toMatch(/<cbc:ResponseCode>1<\/cbc:ResponseCode>\s*<cbc:Description>Intereses<\/cbc:Description>/);
  });
});

describe("the export invoice (international sale)", () => {
  it("is InvoiceTypeCode 02 in its currency with the TRM (PaymentExchangeRate), every amount in USD", () => {
    const inv = exportUsd();
    const xml = buildInvoiceXml(inv);
    expect(xml).toContain("<cbc:InvoiceTypeCode>02</cbc:InvoiceTypeCode>");
    expect(xml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>");
    expect(xml).toMatch(/<cac:PaymentExchangeRate>\s*<cbc:SourceCurrencyCode>USD<\/cbc:SourceCurrencyCode>\s*<cbc:SourceCurrencyBaseRate>1.00<\/cbc:SourceCurrencyBaseRate>\s*<cbc:TargetCurrencyCode>COP<\/cbc:TargetCurrencyCode>\s*<cbc:TargetCurrencyBaseRate>1.00<\/cbc:TargetCurrencyBaseRate>\s*<cbc:CalculationRate>4123.4567<\/cbc:CalculationRate>\s*<cbc:Date>2026-10-30<\/cbc:Date>/);
    expect(xml).not.toContain('currencyID="COP"');
    expect(xml).toContain('<cbc:PayableAmount currencyID="USD">1250.00</cbc:PayableAmount>');
    // Brand and model are informed for an international invoice (notifications FAZ04 / FAZ05).
    expect(xml).toContain("<cbc:BrandName>Café del Norte</cbc:BrandName>");
    golden("export-invoice-usd.xml", xml);
  });

  it("names the foreign buyer without a Colombian address: its country and address line, no DANE code, its PartyTaxScheme", () => {
    const xml = buildInvoiceXml(exportUsd());
    const customer = xml.slice(xml.indexOf("<cac:AccountingCustomerParty>"), xml.indexOf("</cac:AccountingCustomerParty>"));
    expect(customer).toContain("<cbc:IdentificationCode>US</cbc:IdentificationCode>");
    expect(customer).toContain("<cbc:Line>100 Main St, Portland OR 97201</cbc:Line>");
    expect(customer).not.toMatch(/CountrySubentityCode|<cbc:ID>\d{5}<\/cbc:ID>|>CO</);
    expect(customer).toContain("<cac:PartyTaxScheme>");
    expect(customer).toContain('schemeName="50"');
  });

  it("a foreign buyer passes the pack's party validation without department, municipality or postal code", () => {
    const result = validateParty({ kind: ["customer"], ...FOREIGN, taxScheme: "ZZ" } as never);
    expect(result.errors).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.normalized).toMatchObject({ countryCode: "US", departmentCode: undefined, municipalityCode: undefined });
  });

  it("is annulled by a credit note with CreditNoteTypeCode 02 in the same currency and TRM, referencing the export CUFE", () => {
    const inv = exportUsd();
    const xml = buildNoteXml(annulment(inv));
    expect(xml).toContain("<cbc:CreditNoteTypeCode>02</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cbc:CustomizationID>20</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>");
    expect(xml).toMatch(/<cbc:CalculationRate>4123.4567<\/cbc:CalculationRate>\s*<cbc:Date>2026-10-30<\/cbc:Date>/);
    expect(xml).toContain(`<cbc:UUID schemeName="CUFE-SHA384">${computeCufe(inv)}</cbc:UUID>`);
    expect(xml).toContain('<cbc:PayableAmount currencyID="USD">1250.00</cbc:PayableAmount>');
    expect(xml).not.toContain('currencyID="COP"');
    golden("export-annulment-credit-note.xml", xml);
  });

  it("a document in a foreign currency needs its TRM, and a currency of table 13.3.3", () => {
    const inv = exportUsd();
    expect(() => buildInvoiceXml({ ...inv, exchangeRate: undefined })).toThrow(/TRM/);
    expect(() => buildNoteXml(annulment(inv, { exchangeRate: undefined }))).toThrow(/TRM/);
    expect(() => buildInvoiceXml({ ...inv, currency: "ZZZ" })).toThrow(/13\.3\.3/);
  });
});

describe("CUFE parity of an issued foreign-currency invoice (Task 16 computed it at «Emitir»)", () => {
  it("the pack's invoiceCode of the issue equals the code buildInvoiceXml computes again for the same frozen document", () => {
    const inv = exportUsd();
    const atIssue = einvoicePack.invoiceCode({
      number: inv.number, issueDate: inv.issueDate, issueTime: inv.issueTime, taxed: inv.taxed,
      issuerTaxId: "900373115", customerTaxId: "987654321", technicalKey: RESOLUTION.technicalKey, environment: "habilitacion",
    });
    expect(buildInvoiceXml(inv)).toContain(`schemeName="CUFE-SHA384">${atIssue}</cbc:UUID>`);
    expect(computeCufe(inv)).toBe(atIssue);
  });

  it("the pack's document currencies are the ISO 4217 codes of table 13.3.3 (no longer COP only)", () => {
    expect(einvoicePack.documentCurrencies).toContain("USD");
    expect(einvoicePack.documentCurrencies).toContain("EUR");
    expect(einvoicePack.documentCurrencies).toContain("COP");
  });
});
