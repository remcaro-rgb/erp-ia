import { describe, expect, it } from "vitest";
import type { TaxLineInput } from "@erp/kernel";
import { computeCude, computeCufe, computeSoftwareSecurityCode } from "../einvoice/cufe";
import {
  buildInvoiceXml,
  buildNoteXml,
  assertEInvoiceDocument,
  type EInvoiceDocument,
  type EInvoiceItem,
  type EInvoiceNote,
  type EInvoiceParty,
} from "../einvoice/xml-builder";
import { computeTaxes } from "../taxes";

const SUPPLIER: EInvoiceParty = {
  personType: "1", documentType: "31", documentNumber: "900373115", checkDigit: "3",
  legalName: "Café del Norte S.A.S.", tradeName: "Café del Norte",
  taxResponsibilities: ["O-23"], taxScheme: "01", countryCode: "CO",
  departmentCode: "05", municipalityCode: "05001", addressLine: "Calle 10 # 5-20",
  invoiceEmail: "facturas@cafedelnorte.co",
};
const CUSTOMER: EInvoiceParty = {
  personType: "2", documentType: "13", documentNumber: "1234567890", checkDigit: null,
  legalName: "Juan Pérez", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "CO",
  departmentCode: "11", municipalityCode: "11001", addressLine: "Carrera 7 # 1-2", invoiceEmail: "juan@test.com",
};
const RESOLUTION = {
  number: "18764000001", prefix: "SETP", from: 990000001, to: 995000000,
  validFrom: "2026-01-01", validTo: "2026-12-31", technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
};
const SOFTWARE = { id: "software-uuid-here", pin: "12345", providerNit: "900373115", providerDv: "3" };

const ITEM: EInvoiceItem = { sku: "CAF-001", description: "Café molido 500 g", idScheme: "999", uomCode: "94" };

type Line = TaxLineInput & { item: EInvoiceItem };
function make(lines: Line[], over: Partial<EInvoiceDocument> = {}, party = CUSTOMER): EInvoiceDocument {
  const taxed = computeTaxes({ lines, party: { responsibilities: party.taxResponsibilities, personType: party.personType }, date: "2026-04-05" });
  return assertEInvoiceDocument({
    environment: "habilitacion", number: "SETP990000001", issueDate: "2026-04-05", issueTime: "14:30:00-05:00",
    resolution: RESOLUTION, software: SOFTWARE, supplier: SUPPLIER, customer: party,
    paymentForm: "1", paymentMeansCode: "10",
    lines: lines.map((l) => ({ item: l.item, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, referencePrice: l.referencePrice, referencePriceType: l.isFreeSample ? "1" : undefined })),
    taxed, ...over,
  });
}
const base = (): Line => ({ item: ITEM, quantity: 2, unitPrice: 45000, ivaRate: "19" });

describe("assertEInvoiceDocument", () => {
  it("requires one taxed line per document line", () => {
    const d = make([base()]);
    expect(() => assertEInvoiceDocument({ ...d, lines: [...d.lines, d.lines[0]!] })).toThrow(/lines/);
  });
});

describe("buildInvoiceXml", () => {
  it("is UBL 2.1 Invoice with the DIAN profile, number, environment and type", () => {
    const xml = buildInvoiceXml(make([base()]));
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<Invoice");
    expect(xml).toContain("</Invoice>");
    expect(xml).toContain("<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>");
    expect(xml).toContain("<cbc:ProfileID>DIAN 2.1: Factura Electrónica de Venta</cbc:ProfileID>");
    expect(xml).toContain("<cbc:ID>SETP990000001</cbc:ID>");
    expect(xml).toContain("<cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>");
    expect(xml).toContain("<cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>");
    expect(xml).toContain("<cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>");
  });

  it("embeds the CUFE computed from the document and the software security code", () => {
    const d = make([base()]);
    const xml = buildInvoiceXml(d);
    const cufe = computeCufe(d);
    expect(cufe).toMatch(/^[0-9a-f]{96}$/);
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${cufe}</cbc:UUID>`);
    expect(xml).toContain(computeSoftwareSecurityCode("software-uuid-here", "12345", "SETP990000001"));
  });

  it("feeds the CUFE from taxed totals: IVA 01, INC 04, no ICA", () => {
    const d = make([{ ...base(), incRate: "8" }]);
    expect(d.taxed.total).toBe(114300);
    const a = computeCufe(d);
    const b = computeCufe({ ...d, taxed: { ...d.taxed, total: 1 } });
    expect(a).not.toBe(b);
  });

  it("emits supplier and customer with DIAN scheme attributes", () => {
    const xml = buildInvoiceXml(make([base()]));
    expect(xml).toContain('<cbc:CompanyID schemeID="3" schemeName="31" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">900373115</cbc:CompanyID>');
    expect(xml).toContain("<cbc:Name>Café del Norte</cbc:Name>");
    expect(xml).toContain('<cbc:CompanyID schemeName="13" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">1234567890</cbc:CompanyID>');
    expect(xml).toContain("Juan Pérez");
    expect(xml).toContain("<cbc:AdditionalAccountID>2</cbc:AdditionalAccountID>");
    expect(xml).toContain("<cbc:TaxLevelCode listName=\"48\">O-23</cbc:TaxLevelCode>");
    expect(xml).toContain("<cbc:CityName>Medellín</cbc:CityName>");
    expect(xml).toContain("<cbc:ElectronicMail>juan@test.com</cbc:ElectronicMail>");
  });

  it("carries resolution and software in the DIAN extensions, with the signature placeholder", () => {
    const xml = buildInvoiceXml(make([base()]));
    expect(xml).toContain("<sts:InvoiceAuthorization>18764000001</sts:InvoiceAuthorization>");
    expect(xml).toContain("<sts:Prefix>SETP</sts:Prefix>");
    expect(xml).toContain("<sts:From>990000001</sts:From>");
    expect(xml.match(/<ext:UBLExtension>/g)).toHaveLength(2);
    expect(xml).toContain("SIGNATURE_PLACEHOLDER");
  });

  it("groups document taxes per tax code and reports the totals of TaxedDocument", () => {
    const d = make([{ ...base(), ivaRate: "19" }, { ...base(), ivaRate: "5" }, { ...base(), ivaRate: "19", incRate: "8" }]);
    const xml = buildInvoiceXml(d);
    // document-level: one TaxTotal per scheme (01, 04), IVA with two rate subtotals
    const doc = xml.slice(xml.indexOf("<cac:TaxTotal>"), xml.indexOf("<cac:LegalMonetaryTotal>"));
    expect(doc.match(/<cac:TaxTotal>/g)).toHaveLength(2);
    expect(doc.match(/<cac:TaxSubtotal>/g)).toHaveLength(3);
    expect(doc).toContain("<cbc:Percent>19.00</cbc:Percent>");
    expect(doc).toContain("<cbc:Percent>5.00</cbc:Percent>");
    expect(doc).toContain("<cbc:Percent>8.00</cbc:Percent>");
    expect(xml).toContain(`<cbc:LineExtensionAmount currencyID="COP">${d.taxed.subtotal.toFixed(2)}</cbc:LineExtensionAmount>`);
    expect(xml).toContain(`<cbc:PayableAmount currencyID="COP">${d.taxed.total.toFixed(2)}</cbc:PayableAmount>`);
    expect(xml).toContain(`<cbc:TaxInclusiveAmount currencyID="COP">${d.taxed.total.toFixed(2)}</cbc:TaxInclusiveAmount>`);
  });

  it("emits line amounts from the taxed line (not recomputed)", () => {
    const xml = buildInvoiceXml(make([base()]));
    expect(xml).toContain("<cac:InvoiceLine>");
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="94">2</cbc:InvoicedQuantity>');
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="COP">90000.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="COP">17100.00</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:PriceAmount currencyID="COP">45000.00</cbc:PriceAmount>');
  });

  it("emits a line discount as AllowanceCharge and keeps the line base net", () => {
    const xml = buildInvoiceXml(make([{ ...base(), discount: 10000 }]));
    expect(xml).toContain("<cbc:ChargeIndicator>false</cbc:ChargeIndicator>");
    expect(xml).toContain('<cbc:Amount currencyID="COP">10000.00</cbc:Amount>');
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="COP">80000.00</cbc:LineExtensionAmount>');
  });

  it("identifies the mandante per line for ingresos para terceros", () => {
    const d = make([base(), { ...base(), item: { ...ITEM, sku: "COM" } }]);
    d.lines[0] = { ...d.lines[0]!, thirdParty: { documentType: "31", documentNumber: "901234567", name: "Restaurante El Muelle SAS" } };
    const xml = buildInvoiceXml(d);
    expect(xml.match(/<cac:InformationContentProviderParty>/g)).toHaveLength(1);
    expect(xml).toContain('<cbc:ID schemeID="31" schemeName="31">901234567</cbc:ID>');
  });

  it("emits document-level charges that raise only the payable amount", () => {
    const d = make([base()], { charges: [{ reason: "Propina voluntaria", multiplierFactor: 10, amount: 9000, baseAmount: 90000 }] });
    const xml = buildInvoiceXml(d);
    expect(xml).toContain("<cbc:ChargeIndicator>true</cbc:ChargeIndicator>");
    expect(xml).toContain('<cbc:ChargeTotalAmount currencyID="COP">9000.00</cbc:ChargeTotalAmount>');
    expect(xml).toContain(`<cbc:PayableAmount currencyID="COP">${(d.taxed.total + 9000).toFixed(2)}</cbc:PayableAmount>`);
    expect(xml).toContain(`<cbc:TaxExclusiveAmount currencyID="COP">90000.00</cbc:TaxExclusiveAmount>`);
  });

  it("escapes XML in free text", () => {
    const xml = buildInvoiceXml(make([{ ...base(), item: { ...ITEM, description: 'Té "A&B" <x>' } }]));
    expect(xml).toContain("Té &quot;A&amp;B&quot; &lt;x&gt;");
  });

  it("reports an excluded product with the ZZ scheme and no rate", () => {
    const xml = buildInvoiceXml(make([{ ...base(), ivaRate: "EXC" }]));
    const body = xml.slice(xml.indexOf("<cac:TaxTotal>"));
    expect(body).toContain("<cbc:ID>ZZ</cbc:ID>");
    expect(body).not.toContain("<cbc:ID>01</cbc:ID>");
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="COP">90000.00</cbc:TaxExclusiveAmount>');
  });

  it("informs a free sample at price 0 with the reference price and its line tax", () => {
    const d = make([base(), { item: ITEM, quantity: 3, unitPrice: 0, ivaRate: "19", isFreeSample: true, referencePrice: 10000 }]);
    const xml = buildInvoiceXml(d);
    const lines = xml.split("<cac:InvoiceLine>").slice(1);
    expect(lines).toHaveLength(2);
    const free = lines[1]!;
    expect(free).toContain("<cbc:FreeOfChargeIndicator>true</cbc:FreeOfChargeIndicator>");
    expect(free).toContain('<cbc:LineExtensionAmount currencyID="COP">0.00</cbc:LineExtensionAmount>');
    expect(free).toContain('<cbc:PriceAmount currencyID="COP">0.00</cbc:PriceAmount>');
    expect(free).toContain("<cac:AlternativeConditionPrice>");
    expect(free).toContain('<cbc:PriceAmount currencyID="COP">10000.00</cbc:PriceAmount>');
    expect(free).toContain("<cbc:PriceTypeCode>01</cbc:PriceTypeCode>");
    // line TaxTotal informed on the reference base: 3 x 10000 x 19 %
    expect(free).toContain('<cbc:TaxableAmount currencyID="COP">30000.00</cbc:TaxableAmount>');
    expect(free).toContain('<cbc:TaxAmount currencyID="COP">5700.00</cbc:TaxAmount>');
    // the charged line is not marked free
    expect(lines[0]).not.toContain("FreeOfChargeIndicator");
    // document totals exclude the sample (TaxedDocument contract)
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="COP">90000.00</cbc:LineExtensionAmount>');
    expect(xml).toContain(`<cbc:PayableAmount currencyID="COP">${d.taxed.total.toFixed(2)}</cbc:PayableAmount>`);
  });

  it("says in the document-level TaxTotal only the charged lines' taxes when a free sample is present", () => {
    const d = make([base(), { item: ITEM, quantity: 3, unitPrice: 0, ivaRate: "19", isFreeSample: true, referencePrice: 10000 }]);
    const xml = buildInvoiceXml(d);
    const doc = xml.slice(xml.indexOf("</cac:PaymentMeans>"), xml.indexOf("<cac:LegalMonetaryTotal>"));
    expect(doc).toContain('<cbc:TaxableAmount currencyID="COP">90000.00</cbc:TaxableAmount>');
    expect(doc).toContain('<cbc:TaxAmount currencyID="COP">17100.00</cbc:TaxAmount>');
    expect(doc).not.toContain("5700.00");
  });

  describe("StandardItemIdentification per product id_scheme", () => {
    const cases: [EInvoiceItem["idScheme"], string, string, string][] = [
      ["999", "CAF-001", 'schemeID="999" schemeName="Estándar de adopción del contribuyente"', "CAF-001"],
      ["010", "7701234567893", 'schemeID="010" schemeName="GTIN" schemeAgencyID="9"', "07701234567893"],
      ["001", "50201700", 'schemeID="001" schemeName="UNSPSC" schemeAgencyID="10"', "50201700"],
      ["020", "0901210000", 'schemeID="020" schemeName="Partida arancelaria" schemeAgencyID="195"', "0901210000"],
    ];
    for (const [scheme, code, attrs, shown] of cases) {
      it(`scheme ${scheme}`, () => {
        const item: EInvoiceItem = { ...ITEM, idScheme: scheme, standardCode: scheme === "999" ? undefined : code, brand: "Norte", model: "M1" };
        const xml = buildInvoiceXml(make([{ ...base(), item }]));
        expect(xml).toContain(`<cac:StandardItemIdentification>`);
        expect(xml).toContain(`<cbc:ID ${attrs}>${shown}</cbc:ID>`);
        expect(xml).toContain("<cbc:BrandName>Norte</cbc:BrandName>");
        expect(xml).toContain("<cbc:ModelName>M1</cbc:ModelName>");
        expect(xml).toContain("<cbc:ID>CAF-001</cbc:ID>"); // SellersItemIdentification keeps the SKU
      });
    }
    it("a non-own scheme without its standard code is refused", () => {
      expect(() => buildInvoiceXml(make([{ ...base(), item: { ...ITEM, idScheme: "010" } }]))).toThrow(/standardCode/);
    });
  });
});

describe("buildNoteXml", () => {
  const inv = make([base()]);
  const credit = (over: Partial<EInvoiceNote> = {}): EInvoiceNote => ({
    ...inv, kind: "credit", number: "NC1", customizationId: "20", responseCode: "2", typeCode: "91",
    description: "Anulación de factura electrónica",
    reference: { number: "SETP990000001", cufe: computeCufe(inv), issueDate: "2026-04-05" }, ...over,
  });

  it("credit note: CreditNote root, CUDE with the software pin, billing reference and inputs", () => {
    const n = credit();
    const xml = buildNoteXml(n);
    expect(xml).toContain("<CreditNote");
    expect(xml).toContain("</CreditNote>");
    expect(xml).not.toContain("<Invoice");
    expect(xml).toContain("<cbc:CustomizationID>20</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cbc:ResponseCode>2</cbc:ResponseCode>");
    expect(xml).toContain("<cbc:ReferenceID>SETP990000001</cbc:ReferenceID>");
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUDE-SHA384">${computeCude(n)}</cbc:UUID>`);
    expect(xml).toContain("<cac:BillingReference>");
    expect(xml).toContain('schemeName="CUFE-SHA384">' + computeCufe(inv));
    expect(xml).toContain("<cac:CreditNoteLine>");
    expect(xml).toContain("<cbc:CreditedQuantity");
    expect(xml).toContain("<cac:LegalMonetaryTotal>");
  });

  it("response code, customization and type code are inputs, not constants", () => {
    const xml = buildNoteXml(credit({ customizationId: "22", responseCode: "3", typeCode: "02", description: "Rebaja" }));
    expect(xml).toContain("<cbc:CustomizationID>22</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:ResponseCode>3</cbc:ResponseCode>");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>02</cbc:CreditNoteTypeCode>");
  });

  it("debit note: DebitNote root, DebitNoteLine and RequestedMonetaryTotal", () => {
    const xml = buildNoteXml(credit({ kind: "debit", customizationId: "30", responseCode: "1", typeCode: "92" }));
    expect(xml).toContain("<DebitNote");
    expect(xml).not.toContain("NoteTypeCode"); // UBL 2.1 DebitNote has no type code
    expect(xml).toContain("<cac:DebitNoteLine>");
    expect(xml).toContain("<cbc:DebitedQuantity");
    expect(xml).toContain("<cac:RequestedMonetaryTotal>");
    expect(xml).not.toContain("<cac:LegalMonetaryTotal>");
  });

  it("the CUDE differs from the CUFE of the same figures only through the key", () => {
    const n = credit();
    expect(computeCude(n)).not.toBe(computeCufe(inv));
  });
});

const num = (xml: string, re: RegExp): number[] => [...xml.matchAll(re)].map((m) => Number(m[1]));
const cents = (n: number): number => Math.round(n * 100);

describe("line-level TaxTotal is one per tax scheme", () => {
  it("a line with IVA + INC + an other tax emits three TaxTotals, each with its own subtotal", () => {
    const xml = buildInvoiceXml(make([{ ...base(), incRate: "8", otherTaxes: [{ code: "34", ratePercent: 10 }] }]));
    const line = xml.slice(xml.indexOf("<cac:InvoiceLine>"));
    expect(line.match(/<cac:TaxTotal>/g)).toHaveLength(3);
    for (const t of line.split("<cac:TaxTotal>").slice(1)) expect(t.match(/<cac:TaxSubtotal>/g)).toHaveLength(1);
    expect(line).toContain("<cbc:ID>34</cbc:ID>");
  });
});

describe("totals add up to the cent", () => {
  const lines: Line[] = [
    { ...base(), quantity: 3, unitPrice: 3333.33, ivaRate: "19" },
    { ...base(), quantity: 7, unitPrice: 1234.56, ivaRate: "5", discount: 100.11 },
    { ...base(), ivaRate: "19", incRate: "8", otherTaxes: [{ code: "34", ratePercent: 10 }] },
    { ...base(), quantity: 1, unitPrice: 777.77, ivaRate: "0" },
  ];
  const withCharge = (extra: Line[] = []) => make([...lines, ...extra], { charges: [{ reason: "Propina", multiplierFactor: 10, amount: 500.55, baseAmount: 5005.5 }] });

  for (const [name, extra] of [["taxable lines", []], ["with an excluded line", [{ ...base(), unitPrice: 1111.11, ivaRate: "EXC" } as Line]]] as const) {
    it(`reconciles ${name}`, () => {
      const xml = buildInvoiceXml(withCharge([...extra]));
      const tail = xml.slice(xml.indexOf("<cac:TaxTotal>"));
      const docEnd = tail.indexOf("<cac:LegalMonetaryTotal>");
      const docTaxes = tail.slice(0, docEnd);
      const docAmounts = [...docTaxes.matchAll(/<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="COP">([\d.]+)</g)].map((m) => Number(m[1]));
      const monetary = tail.slice(docEnd, tail.indexOf("</cac:LegalMonetaryTotal>"));
      const get = (tag: string) => num(monetary, new RegExp(`<cbc:${tag} currencyID="COP">([\\d.]+)<`, "g"))[0] as number;
      const docTax = docAmounts.reduce((a, b) => a + cents(b), 0);
      expect(cents(get("TaxExclusiveAmount")) + docTax).toBe(cents(get("TaxInclusiveAmount")));
      expect(cents(get("LineExtensionAmount"))).toBe(cents(get("TaxExclusiveAmount")));
      expect(cents(get("TaxInclusiveAmount")) + cents(get("ChargeTotalAmount"))).toBe(cents(get("PayableAmount")));
      // sum of line TaxTotal amounts (the first TaxAmount of each line TaxTotal) = sum of document TaxTotal amounts
      const lineSection = tail.slice(tail.indexOf("</cac:LegalMonetaryTotal>"));
      const lineAmounts = [...lineSection.matchAll(/<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="COP">([\d.]+)</g)].map((m) => cents(Number(m[1])));
      expect(lineAmounts.reduce((a, b) => a + b, 0)).toBe(docTax);
    });
  }

  it("an excluded line keeps its base in LineExtension and TaxExclusive so Exclusive + taxes = Inclusive", () => {
    const d = make([base(), { ...base(), unitPrice: 1000, quantity: 1, ivaRate: "EXC" }]);
    const xml = buildInvoiceXml(d);
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="COP">91000.00</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="COP">108100.00</cbc:TaxInclusiveAmount>');
  });
});

describe("CUFE and ICA", () => {
  it("refuses an ICA tax (code 03) instead of hashing 0.00", () => {
    const d = make([base()]);
    const bad = { ...d, taxed: { ...d.taxed, taxes: [...d.taxed.taxes, { family: "OTHER" as const, code: "03", rate: 1, base: 1, amount: 1 }] } };
    expect(() => computeCufe(bad)).toThrow(/ICA/);
  });
});
