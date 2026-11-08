// The Colombia pack's electronic-invoicing entry for the kernel's CountryPack interface (plan 2B Task 16, rule 5): the invoicing module
// numbers an invoice by its DIAN resolution and computes its CUFE through it, never importing the pack. Server-only (node:crypto), so the
// server registers it beside the pack: `registerCountryPack({ ...co, einvoice: einvoicePack })`.
import type { DrawnDocumentNumber, EInvoiceDocumentInput, EInvoiceNoteInput, EInvoicePack, ResolutionInfo } from "@erp/kernel";
import { round2 } from "../taxes/round";
import { inspectCertificate, loadCertificate, saveCertificate } from "./certificate";
import { computeCUFE, computeCude, computeCufe } from "./cufe";
import { computeNitDv } from "./nit";
import { DOCUMENT_TYPES } from "../document-types";
import { DIAN_CHECKLIST } from "./dian-checklist";
import { signInvoice } from "./signer";
import { assertTransportEnvironment, createEInvoiceTransport } from "./transport";
import { certificateHolds, dianQrPayload, resolutionLegend } from "./representation";
import { assertEInvoiceDocument, buildInvoiceXml, buildNoteXml, type EInvoiceDocument, type EInvoiceNote } from "./xml-builder";
import { ANNULMENT_CONCEPT, CREDIT_NOTE_CONCEPTS, CURRENCIES, DEBIT_NOTE_CONCEPTS, EXPORT_INVOICE_TYPE, NATIONAL_INVOICE_TYPE } from "./tables/dian-tables";
import { isResolutionData, nextInvoiceNumber, ResolutionError, type NumberingTx, type Resolution } from "./resolution";

/** Table 13.3.4.2 (medios de pago) codes the invoices of this release accept. UNCONFIRMED subset: the full table is in the DIAN toolbox. */
const PAYMENT_MEANS = ["1", "10", "20", "42", "47", "48", "49", "71", "ZZZ"] as const;

/** A NIT or document number as the CUFE carries it: the digits before the check digit ("900373115-3" → "900373115"). */
const taxIdDigits = (taxId: string) => (taxId.split("-")[0] ?? "").replace(/\D/g, "");

/**
 * The customer's identification as the document and its code carry it (Task 18 fix round 1). A foreign document (the alphanumeric types of
 * DIAN table 13.2.1: 41 pasaporte, 42 documento extranjero, 50 NIT de otro país) keeps its letters and digits, without separators; a
 * national one (13, 31, 22…) is reduced to its digits, as before. Without its type (or `digitsOnly`, an invoice issued before this fix),
 * the digits: what Task 16 computed the CUFE over. UNCONFIRMED in habilitación (the annex names no normalization of a foreign id).
 */
function customerId(documentNumber: string, documentType: string | undefined, digitsOnly = false): string {
  const alnum = !digitsOnly && documentType !== undefined && DOCUMENT_TYPES[documentType as keyof typeof DOCUMENT_TYPES]?.charset === "alnum";
  return alnum ? documentNumber.replace(/[^A-Za-z0-9]/g, "") : taxIdDigits(documentNumber);
}

/**
 * The kernel's document (plan 2B Task 17) as the UBL builder takes it: the company is a NIT (document type 31, persona jurídica) with its
 * check digit, the software provider's check digit is computed, the tax ids lose anything that is not a digit.
 */
function toDocument(d: EInvoiceDocumentInput): EInvoiceDocument {
  const issuerNit = taxIdDigits(d.issuer.taxId);
  const providerNit = taxIdDigits(d.software.providerTaxId);
  const issuer: Omit<EInvoiceDocumentInput["issuer"], "taxId"> & { taxId?: string } = { ...d.issuer };
  delete issuer.taxId;
  return assertEInvoiceDocument({
    environment: d.environment,
    number: d.number,
    issueDate: d.issueDate,
    issueTime: d.issueTime,
    ...(d.resolution ? { resolution: d.resolution } : {}),
    software: { id: d.software.id, pin: d.software.pin, providerNit, providerDv: String(computeNitDv(providerNit)) },
    supplier: { ...issuer, personType: "1", documentType: "31", documentNumber: issuerNit, checkDigit: String(computeNitDv(issuerNit)) },
    customer: { ...d.customer, documentNumber: customerId(d.customer.documentNumber, d.customer.documentType, d.customerIdDigitsOnly) },
    paymentForm: d.paymentForm,
    paymentMeansCode: d.paymentMeansCode,
    ...(d.dueDate ? { dueDate: d.dueDate } : {}),
    lines: d.lines,
    taxed: d.taxed,
    ...(d.currency ? { currency: d.currency } : {}),
    ...(d.exchangeRate ? { exchangeRate: d.exchangeRate } : {}),
    ...(d.export !== undefined ? { export: d.export } : {}),
  } as EInvoiceDocument);
}

/** The kernel's note (plan 2B Task 18) as the UBL builder takes it: the document of its lines, its concept and the invoice it corrects. */
function toNote(n: EInvoiceNoteInput): EInvoiceNote {
  return {
    ...toDocument(n),
    kind: n.kind,
    responseCode: n.concept,
    reference: { number: n.reference.number, cufe: n.reference.code, issueDate: n.reference.issueDate, invoiceTypeCode: n.reference.export ? EXPORT_INVOICE_TYPE : NATIONAL_INVOICE_TYPE },
  };
}

const info = (r: Omit<Resolution, "technicalKey">): ResolutionInfo => ({ number: r.number, prefix: r.prefix, from: r.from, to: r.to, validFrom: r.validFrom, validTo: r.validTo });

export const einvoicePack: EInvoicePack = {
  // Task 35: the values the admin verifies against the DIAN's habilitación before producción (fiscal content: rule 5).
  dianChecklist: DIAN_CHECKLIST,
  /**
   * Task 3's nextInvoiceNumber, answered as the kernel's contract (refusals carry the resolution's data, never thrown). An invoice needs
   * its resolution (the CUFE's technical key); a note is numbered by its plain sequence (Task 18 fix round 1).
   */
  async nextNumber(tx, companyId, type, issuedAt): Promise<DrawnDocumentNumber> {
    try {
      const drawn = await nextInvoiceNumber(tx as unknown as NumberingTx, companyId, type, issuedAt);
      const base = { ok: true as const, prefix: drawn.prefix, number: drawn.number, full: drawn.full };
      if (drawn.resolution) return { ...base, resolution: info(drawn.resolution), technicalKey: drawn.resolution.technicalKey };
      // Without the resolution it drew from there is no technical key for the CUFE.
      return type === "invoice" ? { ok: false, code: "no_resolution" } : base;
    } catch (error) {
      if (!(error instanceof ResolutionError)) throw error;
      return { ok: false, code: error.code, ...(error.resolution && isResolutionData(error.resolution) ? { resolution: info(error.resolution) } : {}) };
    }
  },
  invoiceCode(input) {
    const sum = (family: "IVA" | "INC") => round2(input.taxed.taxes.filter((t) => t.family === family).reduce((s, t) => s + t.amount, 0));
    return computeCUFE({
      invoiceNumber: input.number,
      issueDate: input.issueDate,
      issueTime: input.issueTime,
      subtotal: input.taxed.subtotal,
      ivaAmount: sum("IVA"),
      incAmount: sum("INC"),
      // The ICA slot: the tax engine computes no ICA on a sale (Task 4), so it is 0.00 as the Anexo allows.
      icaAmount: 0,
      total: input.taxed.total,
      issuerNit: taxIdDigits(input.issuerTaxId),
      customerIdNumber: customerId(input.customerTaxId, input.customerDocumentType),
      technicalKey: input.technicalKey,
      environment: input.environment === "produccion" ? "1" : "2",
    });
  },
  paymentForms: ["1", "2"],
  paymentMeans: PAYMENT_MEANS,
  // DIAN table 13.3.4.2 by kind of medio de pago: 10 efectivo; 42 consignación, 47 transferencia débito; 48 tarjeta crédito, 49 tarjeta
  // débito; 20 cheque; 1 instrumento no definido, 71 bonos, ZZZ otro.
  paymentMeansByKind: { cash: ["10"], transfer: ["42", "47"], card: ["48", "49"], check: ["20"], other: ["1", "71", "ZZZ"] },
  // 10: efectivo (DIAN table 13.3.4.2).
  defaultPaymentMeans: "10",
  taxIdUsable: (taxId, documentType) => customerId(taxId, documentType).length > 0,
  // Any currency of DIAN table 13.3.3 (Task 18): the document carries the invoice's currency and TRM; a buyer abroad makes it an export
  // (InvoiceTypeCode 02). The CUFE is computed on the document's amounts, as «Emitir» computed it (parity for issued invoices).
  documentCurrencies: CURRENCIES,
  buildInvoiceXml(input) {
    const doc = toDocument(input);
    return { xml: buildInvoiceXml(doc), code: computeCufe(doc) };
  },
  noteConcepts: { credit: CREDIT_NOTE_CONCEPTS, debit: DEBIT_NOTE_CONCEPTS },
  annulmentConcept: ANNULMENT_CONCEPT,
  buildNoteXml(input) {
    const note = toNote(input);
    return { xml: buildNoteXml(note), code: computeCude(note) };
  },
  async signXml(xml, secrets, companyId) {
    return signInvoice(xml, await loadCertificate(secrets, companyId));
  },
  transport: ({ secrets, companyId, environment }) => createEInvoiceTransport(process.env, { companyId, ...(secrets ? { secrets } : {}), ...(environment ? { environment } : {}) }),
  assertTransportEnvironment,
  // Task 19: the graphic representation (QR, numbering legend) and the certificate of Parámetros.
  representation: { qrPayload: dianQrPayload, resolutionLegend },
  inspectCertificate,
  certificateHolds,
  async storeCertificate(secrets, companyId, file, password) {
    const { fingerprint } = await saveCertificate(secrets, companyId, Buffer.from(file), password);
    return { fingerprint };
  },
};
