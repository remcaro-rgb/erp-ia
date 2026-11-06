import type { ResolutionInfo } from "@erp/kernel";
import { computeNitDv } from "./nit";

// The graphic representation of a Colombian electronic document (plan 2B Task 19; Anexo Técnico 1.9 of the DIAN): what its PDF prints besides
// the invoice's own fields.
//  - The QR code: the DIAN's query of the document by its unique code (CUFE of an invoice, CUDE of a note), on the environment's catalogue
//    (habilitación has its own host). The URL is the one Serena's port printed and the DIAN catalogue answers (`dianQrUrl`,
//    src/lib/dian/mock.ts); pinned by einvoice-representation.test.ts.
//  - The legend of the numbering authorization of an invoice: the resolution's number, its prefix, the authorized range and its validity
//    (the data `core.next_document_number` drew the number from, frozen on the invoice). The wording is the pack's (fiscal text, rule 5),
//    in the print's language.

const CATALOGUE: Record<"habilitacion" | "produccion", string> = {
  produccion: "https://catalogo-vpfe.dian.gov.co",
  habilitacion: "https://catalogo-vpfe-hab.dian.gov.co",
};

/** A CUFE or CUDE: SHA-384 in hex. */
const DOCUMENT_KEY = /^[0-9a-f]{96}$/;

/** The text of the document's QR code: the DIAN's query of the document by its CUFE / CUDE. */
export function dianQrPayload(code: string, environment: "habilitacion" | "produccion"): string {
  if (!DOCUMENT_KEY.test(code)) throw new Error(`the QR names a document by its CUFE / CUDE (96 hex digits), got "${code.slice(0, 20)}"`);
  return `${CATALOGUE[environment]}/document/searchqr?documentkey=${code}`;
}

/** `AAAA/MM/DD`, as the kernel prints dates on paper. */
const paperDate = (iso: string) => iso.replaceAll("-", "/");

/** The legend of the invoice's numbering authorization, in `locale` (es-419 by default; en). */
export function resolutionLegend(r: ResolutionInfo, locale: string): string {
  const en = locale.toLowerCase().startsWith("en");
  if (en) {
    const prefix = r.prefix ? `prefix ${r.prefix}` : "no prefix";
    return `DIAN numbering resolution No. ${r.number}: ${prefix}, from ${r.from} to ${r.to}, valid from ${paperDate(r.validFrom)} to ${paperDate(r.validTo)}`;
  }
  const prefix = r.prefix ? `prefijo ${r.prefix}` : "sin prefijo";
  return `Resolución DIAN de numeración N.º ${r.number}: ${prefix}, del ${r.from} al ${r.to}, vigente del ${paperDate(r.validFrom)} al ${paperDate(r.validTo)}`;
}

/**
 * Whether the tax id a signing certificate names (its subject's serialNumber: `900373115`, `900373115-3`, `NIT 900.373.115-3`) is the
 * company's NIT (stored without check digit): the same digits, or the same digits followed by the NIT's own check digit.
 */
export function certificateHolds(subjectTaxId: string, companyTaxId: string): boolean {
  const company = companyTaxId.split("-")[0]!.replace(/\D/g, "");
  const subject = subjectTaxId.replace(/\D/g, "");
  if (!company || !subject) return false;
  return subject === company || subject === `${company}${computeNitDv(company)}`;
}
