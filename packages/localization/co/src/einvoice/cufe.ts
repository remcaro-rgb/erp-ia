// CUFE / CUDE / software security code (ported from Serena src/lib/dian/cufe.ts; hashing unchanged).
import { createHash } from "node:crypto";
import { round2 } from "../taxes/round";
import type { EInvoiceDocument, EInvoiceNote } from "./xml-builder";

export interface CUFEParams {
  invoiceNumber: string;
  issueDate: string;
  issueTime: string;
  subtotal: number;
  ivaAmount: number;
  incAmount: number;
  icaAmount: number;
  total: number;
  issuerNit: string;
  customerIdNumber: string;
  technicalKey: string;
  environment: "1" | "2";
}

export interface CUDEParams extends Omit<CUFEParams, "technicalKey"> {
  softwarePin: string;
}

const formatAmount = (n: number): string => n.toFixed(2);
const sha384 = (input: string): string => createHash("sha384").update(input, "utf8").digest("hex");

function concatenation(p: Omit<CUFEParams, "technicalKey">, key: string): string {
  return [
    p.invoiceNumber, p.issueDate, p.issueTime, formatAmount(p.subtotal),
    "01", formatAmount(p.ivaAmount), "04", formatAmount(p.incAmount), "03", formatAmount(p.icaAmount),
    formatAmount(p.total), p.issuerNit, p.customerIdNumber, key, p.environment,
  ].join("");
}

/** CUFE of an invoice: NumFac+FecFac+HorFac+ValFac+01+ValIVA+04+ValINC+03+ValICA+ValTot+NitOFE+NumAdq+ClTec+TipoAmb, SHA-384. */
export function computeCUFE(params: CUFEParams): string {
  return sha384(concatenation(params, params.technicalKey));
}

/** CUDE of notes and other documents: same concatenation with the software PIN instead of the technical key. */
export function computeCUDE(params: CUDEParams): string {
  return sha384(concatenation(params, params.softwarePin));
}

/**
 * Software security code of the DIAN extensions: SHA-384(SoftwareID + PIN + third argument). Anexo FE 1.9 takes the
 * document number (prefix + consecutive) as the third element; Serena passed the issuer NIT (see the Task 4 report).
 */
export function computeSoftwareSecurityCode(softwareId: string, pin: string, documentNumber: string): string {
  return sha384(softwareId + pin + documentNumber);
}

/** Amount payable of the document: taxed total plus the document-level charges (tip), which sit outside the tax base. */
export function payableAmount(doc: Pick<EInvoiceDocument, "taxed" | "charges">): number {
  return round2(doc.taxed.total + (doc.charges ?? []).reduce((s, c) => s + (c.amount > 0 ? c.amount : 0), 0));
}

function hashParams(doc: EInvoiceDocument) {
  // The ICA slot of the CUFE is not fed by the tax engine; refuse rather than hash a silent 0.00.
  if (doc.taxed.taxes.some((t) => t.code === "03")) throw new Error("CUFE: ICA (code 03) in taxed.taxes is not supported; the ICA slot would be hashed as 0.00");
  const sum = (family: "IVA" | "INC") => round2(doc.taxed.taxes.filter((t) => t.family === family).reduce((s, t) => s + t.amount, 0));
  return {
    invoiceNumber: doc.number,
    issueDate: doc.issueDate,
    issueTime: doc.issueTime,
    subtotal: doc.taxed.subtotal,
    ivaAmount: sum("IVA"),
    incAmount: sum("INC"),
    icaAmount: 0,
    total: payableAmount(doc),
    issuerNit: doc.supplier.documentNumber,
    customerIdNumber: doc.customer.documentNumber,
    environment: (doc.environment === "produccion" ? "1" : "2") as "1" | "2",
  };
}

/** CUFE of an e-invoice document, with the technical key of its resolution. */
export function computeCufe(doc: EInvoiceDocument): string {
  if (!doc.resolution) throw new Error("CUFE: an invoice needs the technical key of its numbering resolution");
  return computeCUFE({ ...hashParams(doc), technicalKey: doc.resolution.technicalKey });
}

/** CUDE of a credit or debit note, with the software PIN. */
export function computeCude(note: EInvoiceNote): string {
  return computeCUDE({ ...hashParams(note), softwarePin: note.software.pin });
}
