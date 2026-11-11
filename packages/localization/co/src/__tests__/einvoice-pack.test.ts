import { describe, expect, it } from "vitest";
import { co } from "../index";
import { computeCUFE } from "../einvoice/cufe";
import { einvoicePack } from "../einvoice/pack";
import type { Resolution } from "../einvoice/resolution";

// The pack's electronic-invoicing entry (plan 2B Task 16): what the invoicing module calls through the kernel's CountryPack interface
// (rule 5) to number an invoice by its DIAN resolution, compute its CUFE and map a tax of the engine to the ledger's tax code.

const resolution: Resolution = {
  number: "18760000001", prefix: "SETP", from: 990000000, to: 990000010,
  validFrom: "2026-01-01", validTo: "2027-12-31", technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
};

function fakeTx(result: unknown) {
  return (async () => [{ result }]) as never;
}

describe("ledgerTaxCode", () => {
  it("names IVA and INC by family and rate, other taxes by their code", () => {
    const code = co.taxes.ledgerTaxCode!;
    expect(code({ family: "IVA", code: "01", rate: 19, base: 100, amount: 19 })).toBe("IVA19");
    expect(code({ family: "IVA", code: "01", rate: 5, base: 100, amount: 5 })).toBe("IVA5");
    expect(code({ family: "IVA", code: "01", rate: 0, base: 100, amount: 0 })).toBe("IVA0");
    expect(code({ family: "INC", code: "04", rate: 8, base: 100, amount: 8 })).toBe("INC8");
    expect(code({ family: "OTHER", code: "22", rate: null, base: 100, amount: 50 })).toBe("22");
  });
});

describe("einvoicePack.nextNumber", () => {
  it("answers the number with the resolution it was drawn from (the technical key apart)", async () => {
    const drawn = await einvoicePack.nextNumber(fakeTx({ status: "ok", prefix: "SETP", number: 990000003, resolution }), "c", "invoice", "2026-06-01");
    expect(drawn).toEqual({
      ok: true, prefix: "SETP", number: 990000003, full: "SETP990000003", technicalKey: resolution.technicalKey,
      resolution: { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000010, validFrom: "2026-01-01", validTo: "2027-12-31" },
    });
  });

  it("draws through Task 3's nextInvoiceNumber: an answer without a valid resolution has no technical key and is refused", async () => {
    expect(await einvoicePack.nextNumber(fakeTx({ status: "ok", prefix: "SETP", number: 990000003 }), "c", "invoice", "2026-06-01")).toEqual({ ok: false, code: "no_resolution" });
    expect(await einvoicePack.nextNumber((async () => []) as never, "c", "invoice", "2026-06-01")).toEqual({ ok: false, code: "no_resolution" });
  });

  it("answers a refusal with its code and the resolution's data, never throwing", async () => {
    expect(await einvoicePack.nextNumber(fakeTx({ status: "out_of_range", resolution }), "c", "invoice", "2026-06-01")).toEqual({
      ok: false, code: "out_of_range", resolution: { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000010, validFrom: "2026-01-01", validTo: "2027-12-31" },
    });
    expect(await einvoicePack.nextNumber(fakeTx({ status: "no_resolution" }), "c", "invoice", "2026-06-01")).toEqual({ ok: false, code: "no_resolution" });
  });
});

describe("einvoicePack.invoiceCode", () => {
  it("is the CUFE of the Anexo: IVA and INC summed by family, the environment code 2 in habilitación", () => {
    const code = einvoicePack.invoiceCode({
      number: "SETP990000001", issueDate: "2026-04-05", issueTime: "14:30:00-05:00",
      taxed: { subtotal: 100000, total: 127000, taxes: [{ family: "IVA", code: "01", rate: 19, base: 100000, amount: 19000 }, { family: "INC", code: "04", rate: 8, base: 100000, amount: 8000 }] },
      issuerTaxId: "900373115", customerTaxId: "860002964", technicalKey: resolution.technicalKey, environment: "habilitacion",
    });
    expect(code).toBe(computeCUFE({
      invoiceNumber: "SETP990000001", issueDate: "2026-04-05", issueTime: "14:30:00-05:00", subtotal: 100000, ivaAmount: 19000, incAmount: 8000,
      icaAmount: 0, total: 127000, issuerNit: "900373115", customerIdNumber: "860002964", technicalKey: resolution.technicalKey, environment: "2",
    }));
    expect(code).toMatch(/^[0-9a-f]{96}$/);
  });

  it("takes the tax ids as stored: a NIT with its check digit names the same CUFE; a tax id without digits is not usable", () => {
    const input = {
      number: "SETP990000001", issueDate: "2026-04-05", issueTime: "14:30:00-05:00",
      taxed: { subtotal: 100000, total: 119000, taxes: [{ family: "IVA" as const, code: "01", rate: 19, base: 100000, amount: 19000 }] },
      technicalKey: resolution.technicalKey, environment: "produccion" as const,
    };
    expect(einvoicePack.invoiceCode({ ...input, issuerTaxId: "900373115-3", customerTaxId: "860.002.964" }))
      .toBe(einvoicePack.invoiceCode({ ...input, issuerTaxId: "900373115", customerTaxId: "860002964" }));
    expect(einvoicePack.taxIdUsable("860002964")).toBe(true);
    expect(einvoicePack.taxIdUsable("")).toBe(false);
    expect(einvoicePack.taxIdUsable("SIN-NUMERO")).toBe(false);
  });

  it("lists the payment forms of table 13.3.4.1 and the payment means it accepts", () => {
    expect(einvoicePack.paymentForms).toEqual(["1", "2"]);
    expect(einvoicePack.paymentMeans).toEqual(expect.arrayContaining(["10", "42", "47", "48", "49", "ZZZ"]));
    // Every means code fits exactly one kind of medio de pago (plan 2B Task 21 fix round 1).
    const byKind = einvoicePack.paymentMeansByKind!;
    expect(Object.keys(byKind).sort()).toEqual(["card", "cash", "check", "other", "transfer"]);
    expect(Object.values(byKind).flat().sort()).toEqual([...einvoicePack.paymentMeans].sort());
    expect(einvoicePack.defaultPaymentMeans).toBe("10");
  });
});

// Task 17: the submission seam the invoicing workflow uses (build, sign, transport), never importing the pack directly.
import { computeTaxes } from "../taxes/compute";
import { InMemorySecretStore, MockEInvoiceTransport, resetMockEInvoiceState } from "@erp/infra";
import type { EInvoiceDocumentInput } from "@erp/kernel";
import { saveCertificate } from "../einvoice/certificate";
import { verifySignedInvoice } from "../einvoice/signer";
import { generateTestCertP12 } from "./helpers/test-cert";

describe("einvoicePack submission (Task 17)", () => {
  const taxed = computeTaxes({ lines: [{ quantity: 2, unitPrice: 10000, kind: "good", ivaRate: "19", otherTaxes: [], isFreeSample: false }], party: { responsibilities: ["O-13"] }, date: "2026-06-01" });
  const doc = (over: Partial<EInvoiceDocumentInput> = {}): EInvoiceDocumentInput => ({
    environment: "habilitacion", number: "SETP990000003", issueDate: "2026-06-01", issueTime: "10:00:00-05:00",
    resolution: { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000010, validFrom: "2026-01-01", validTo: "2027-12-31", technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c" },
    software: { id: "soft-1", pin: "12345", providerTaxId: "900373115" },
    issuer: { taxId: "900373115", legalName: "Café del Norte S.A.S.", taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Calle 1" },
    customer: { personType: "1", documentType: "31", documentNumber: "860002964", checkDigit: "4", legalName: "Distribuidora Andina S.A.S.", taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO" },
    paymentForm: "1", paymentMeansCode: "10",
    lines: [{ item: { sku: "CAF-500", description: "Café", idScheme: "999", uomCode: "94" }, quantity: 2, unitPrice: 10000 }],
    taxed,
    ...over,
  });

  it("builds the invoice XML with the issuer as a NIT (type 31, its check digit) and answers the CUFE it carries, equal to invoiceCode", () => {
    const { xml, code } = einvoicePack.buildInvoiceXml(doc());
    expect(xml).toContain("<cbc:ID>SETP990000003</cbc:ID>");
    expect(xml).toContain(`schemeID="3" schemeName="31"`);
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${code}</cbc:UUID>`);
    expect(code).toBe(einvoicePack.invoiceCode({
      number: "SETP990000003", issueDate: "2026-06-01", issueTime: "10:00:00-05:00", taxed, issuerTaxId: "900373115", customerTaxId: "860002964",
      technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c", environment: "habilitacion",
    }));
    // Task 18: every ISO 4217 code of DIAN table 13.3.3 (the export invoice and foreign-currency invoices), no longer COP only.
    expect(einvoicePack.documentCurrencies).toEqual(expect.arrayContaining(["COP", "USD", "EUR"]));
  });

  it("signs with the company's certificate from the secret store, and refuses without one", async () => {
    const secrets = new InMemorySecretStore();
    await expect(einvoicePack.signXml(einvoicePack.buildInvoiceXml(doc()).xml, secrets, "co-1")).rejects.toThrow(/credentials not configured/);
    const { buffer, password } = generateTestCertP12();
    await saveCertificate(secrets, "co-1", buffer, password);
    const signed = await einvoicePack.signXml(einvoicePack.buildInvoiceXml(doc()).xml, secrets, "co-1");
    expect(signed).toContain("<ds:Signature");
    expect(verifySignedInvoice(signed).valid).toBe(true);
  });

  it("builds the mock transport by default, which knows the trackId of a document before it is sent", async () => {
    resetMockEInvoiceState();
    const t = einvoicePack.transport({ companyId: "co-1" });
    expect(t).toBeInstanceOf(MockEInvoiceTransport);
    expect(t.expectedTrackId?.({ cufe: "a".repeat(96), documentNumber: "X1", issuerNit: "1" })).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// Task 18 fix round 1: a note is numbered by a plain sequence (no DIAN resolution, no technical key); a foreign buyer's identification
// keeps its letters (types 41, 42, 50: alphanumeric) while a national one is reduced to its digits, in the XML and in the CUFE alike.
describe("einvoicePack fix round 1 (Task 18)", () => {
  it("numbers a credit or debit note from a plain sequence row: no resolution, no technical key; an invoice still needs its resolution", async () => {
    for (const type of ["credit_note", "debit_note"] as const) {
      expect(await einvoicePack.nextNumber(fakeTx({ status: "ok", prefix: "NC", number: 7 }), "c", type, "2026-06-01")).toEqual({ ok: true, prefix: "NC", number: 7, full: "NC7" });
    }
    expect(await einvoicePack.nextNumber(fakeTx({ status: "no_sequence" }), "c", "credit_note", "2026-06-01")).toEqual({ ok: false, code: "no_sequence" });
    expect(await einvoicePack.nextNumber(fakeTx({ status: "ok", prefix: "SETP", number: 990000003 }), "c", "invoice", "2026-06-01")).toEqual({ ok: false, code: "no_resolution" });
  });

  const input = {
    number: "SETP990000001", issueDate: "2026-04-05", issueTime: "14:30:00-05:00",
    taxed: { subtotal: 100000, total: 119000, taxes: [{ family: "IVA" as const, code: "01", rate: 19, base: 100000, amount: 19000 }] },
    issuerTaxId: "900373115", technicalKey: resolution.technicalKey, environment: "habilitacion" as const,
  };
  const cufeOf = (customerIdNumber: string) => computeCUFE({
    invoiceNumber: input.number, issueDate: input.issueDate, issueTime: input.issueTime, subtotal: 100000, ivaAmount: 19000, incAmount: 0, icaAmount: 0,
    total: 119000, issuerNit: "900373115", customerIdNumber, technicalKey: resolution.technicalKey, environment: "2",
  });

  it("the CUFE keeps the letters of a foreign document (41, 42, 50) and reduces a national one (13, 31) to its digits; without the type, Task 16's digits", () => {
    for (const type of ["41", "42", "50"]) expect(einvoicePack.invoiceCode({ ...input, customerTaxId: "AB-123 456", customerDocumentType: type })).toBe(cufeOf("AB123456"));
    for (const type of ["13", "31", "22"]) expect(einvoicePack.invoiceCode({ ...input, customerTaxId: "1.234.567", customerDocumentType: type })).toBe(cufeOf("1234567"));
    expect(einvoicePack.invoiceCode({ ...input, customerTaxId: "AB123456" })).toBe(cufeOf("123456"));
    expect(einvoicePack.taxIdUsable("AB123456", "41")).toBe(true);
    expect(einvoicePack.taxIdUsable("ABCDEF", "41")).toBe(true);
    expect(einvoicePack.taxIdUsable("ABCDEF", "13")).toBe(false);
  });

  const taxed = computeTaxes({ lines: [{ quantity: 1, unitPrice: 100, kind: "good", ivaRate: "0", otherTaxes: [], isFreeSample: false }], party: { responsibilities: ["R-99-PN"] }, date: "2026-06-01" });
  const foreign = (over: Partial<EInvoiceDocumentInput> = {}): EInvoiceDocumentInput => ({
    environment: "habilitacion", number: "SETP990000004", issueDate: "2026-06-01", issueTime: "10:00:00-05:00",
    resolution: { ...resolution },
    software: { id: "soft-1", pin: "12345", providerTaxId: "900373115" },
    issuer: { taxId: "900373115", legalName: "Café del Norte S.A.S.", taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Calle 1" },
    customer: { personType: "1", documentType: "42", documentNumber: "AB123456", checkDigit: null, legalName: "Importers LLC", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "US", addressLine: "100 Main St" },
    paymentForm: "1", paymentMeansCode: "10",
    lines: [{ item: { sku: "CAF-500", description: "Café", idScheme: "999", uomCode: "94" }, quantity: 1, unitPrice: 100 }],
    taxed, currency: "USD", exchangeRate: { rate: 4000, date: "2026-06-01" }, export: true,
    ...over,
  });
  const issued = (customerDocumentType?: string) => einvoicePack.invoiceCode({
    number: "SETP990000004", issueDate: "2026-06-01", issueTime: "10:00:00-05:00", taxed, issuerTaxId: "900373115", customerTaxId: "AB123456",
    ...(customerDocumentType ? { customerDocumentType } : {}), technicalKey: resolution.technicalKey, environment: "habilitacion",
  });

  it("the XML of a foreign buyer carries its id with its letters, and its CUFE is the one «Emitir» computed", () => {
    const { xml, code } = einvoicePack.buildInvoiceXml(foreign());
    expect(xml).toContain(">AB123456</cbc:CompanyID>");
    expect(code).toBe(issued("42"));
    expect(xml).toContain("<cbc:InvoiceTypeCode>02</cbc:InvoiceTypeCode>");
  });

  it("an invoice issued with Task 16's digits-only CUFE is built digits-only (customerIdDigitsOnly): the same CUFE, the XML that matches it", () => {
    const { xml, code } = einvoicePack.buildInvoiceXml(foreign({ customerIdDigitsOnly: true }));
    expect(code).toBe(issued());
    expect(xml).toContain(">123456</cbc:CompanyID>");
  });

  it("the export is the frozen flag of the document when it has one, not the buyer's country of today", () => {
    expect(einvoicePack.buildInvoiceXml(foreign({ export: false })).xml).toContain("<cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>");
    const national = foreign({ customer: { ...foreign().customer, documentType: "31", documentNumber: "860002964", checkDigit: "4", countryCode: "CO", departmentCode: "11", municipalityCode: "11001" }, export: true });
    expect(einvoicePack.buildInvoiceXml(national).xml).toContain("<cbc:InvoiceTypeCode>02</cbc:InvoiceTypeCode>");
  });
});
