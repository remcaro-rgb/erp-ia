// DIAN code tables of the electronic sale invoice and its notes, Anexo Técnico 1.9 (Resolución 000165 de 2023), pinned from the DIAN
// toolbox (plan 2B Task 18, step one). Compact, reviewable copies: the raw toolbox is never committed (it is a 26 MB zip of spreadsheets).
//
// Source: https://www.dian.gov.co/impuestos/factura-electronica/Documents/Caja-de-herramientas-FE_V19_v2026.zip
//   (linked from micrositios.dian.gov.co/sistema-de-facturacion-electronica/documentacion-tecnica/ as «Caja de herramientas Factura
//   Electrónica v1.9»), retrieved 2026-11-05, SHA-256 036eac8ca529ee7d13601eebcd77f89394bcd83fb1220f723616292d30685b39, entries dated
//   2026-07-31. Folder «Caja de herramientas FE_V19_(v2026)/Anexo Tecnico/Tablas Referenciadas/», sheet «Hoja1» of each workbook named
//   below. The older zip the plan named (Caja_de_herramientas_Factura_Electronica_Validacion_Previa.zip, SHA-256
//   107fcd5725f51305216b1c55c37b338b21d07f5e2d577f5a5bfa083d0f6575bd, entries of 2023-06-21) holds only the Anexo 1.8 genericode lists
//   (Listas de valores/ConceptoNotaCredito-2.1.gc …): its credit-note concept 5 is «Otros», replaced in 1.9 (see below).
// The tests in ../../__tests__/einvoice-tables.test.ts pin every code: a change of the DIAN tables must be a reviewed change here.

export interface DianCode {
  code: string;
  name: string;
}

/**
 * 13.2.4 «Concepto de Corrección para Notas crédito cac DiscrepancyResponse cbc ResponseCode» (workbook «13.2.4 Concepto de Corrección
 * para Notas crédito cac DiscrepancyResponse cbc ResponseCode.xlsx»). The names are the DIAN's exact descriptions: rule CBF04 rejects a
 * cbc:Description that does not correspond to the code (the double space of code 3 is the DIAN's).
 */
export const CREDIT_NOTE_CONCEPTS: readonly DianCode[] = [
  { code: "1", name: "Devolución parcial de los bienes y/o no aceptación parcial del servicio" },
  { code: "2", name: "Anulación de factura electrónica" },
  { code: "3", name: "Rebaja  o descuento parcial o total" },
  { code: "4", name: "Ajuste de precio" },
  { code: "5", name: "Descuento comercial por pronto pago" },
  { code: "6", name: "Descuento comercial por volumen de ventas" },
];

/** The annulment concept of table 13.2.4 (rule CAD02a: with it, CustomizationID must be "20"; rule CAG01: never with type 22). */
export const ANNULMENT_CONCEPT = "2";

/** 13.2.5 «Concepto de Corrección para Notas débito» (workbook «13.2.5. Concepto de Corrección para Notas débito cac DiscrepancyResponsecbc ResponseCode.xlsx»). */
export const DEBIT_NOTE_CONCEPTS: readonly DianCode[] = [
  { code: "1", name: "Intereses" },
  { code: "2", name: "Gastos por cobrar" },
  { code: "3", name: "Cambio del valor" },
  { code: "4", name: "Otros" },
];

/** 13.1.5.2 «Documento CreditNote – Nota Crédito» (cbc:CustomizationID of a credit note; workbook «13.1.5.2. Documento CreditNote _ Nota Crédito.xlsx»). */
export const CREDIT_NOTE_OPERATIONS: readonly DianCode[] = [
  { code: "20", name: "Nota Crédito que referencia una factura electrónica." },
  { code: "22", name: "Nota Crédito sin referencia a una factura electrónica." },
];

/** 13.1.5.3 «Documento DebitNote – Nota Débito» (cbc:CustomizationID of a debit note; workbook «13.1.5.3. Documento DebitNote _ Nota Débito.xlsx»). */
export const DEBIT_NOTE_OPERATIONS: readonly DianCode[] = [
  { code: "30", name: "Nota Débito que referencia una factura electrónica." },
  { code: "32", name: "Nota Débito sin referencia a una factura electrónica." },
];

/** 13.1.5.1 «Tipos de operación» of the invoice (cbc:CustomizationID; workbook «13.1.5.1 Tipos de operación.xlsx»; the DIAN's spelling). */
export const INVOICE_OPERATIONS: readonly DianCode[] = [
  { code: "09", name: "AIU" },
  { code: "10", name: "Estándar" },
  { code: "11", name: "Mandatos" },
  { code: "12", name: "Transporte" },
  { code: "14", name: "Notariios" },
  { code: "15", name: "Compra Divisas" },
  { code: "16", name: "Venta Divisas" },
];

/**
 * 13.1.3 «Tipo de Documento» (cbc:InvoiceTypeCode, cbc:CreditNoteTypeCode, DocumentReference/DocumentTypeCode; workbook «13.1.3 Tipo de
 * Documento.xlsx»). The workbook's «Uso» column says 91 is «Exclusivo en referencias a documentos (elementos DocumentReference)».
 */
export const DOCUMENT_TYPES: readonly DianCode[] = [
  { code: "01", name: "Factura electrónica de Venta" },
  { code: "02", name: "Factura electrónica de venta -exportación" },
  { code: "03", name: "Instrumento electrónico de transmisión – tipo 03" },
  { code: "04", name: "Factura electrónica de Venta - tipo 04" },
  { code: "91", name: "Nota Crédito" },
  { code: "92", name: "Nota Débito" },
  { code: "96", name: "Eventos (ApplicationResponse)" },
];

/** The InvoiceTypeCode of a national sale and of an export (international sale). */
export const NATIONAL_INVOICE_TYPE = "01";
export const EXPORT_INVOICE_TYPE = "02";

/**
 * cbc:CreditNoteTypeCode of a credit note. Export: "02" — the Anexo 1.9 applies the export validation set to a credit note when
 * «//cbc:CreditNoteTypeCode = "02"» (rule CAK19, PartyTaxScheme of the buyer). National: "91" — UNCONFIRMED: the annex's CAD12 sends to
 * table 13.1.3 (broken reference «numeral 0»), whose «Uso» column reserves 91 for document references, yet the DIAN's own example of the
 * 1.9 toolbox (Ejemplificaciones/XMLs de ejemplo/CreditNote.xml) carries 91; confirm in habilitación.
 */
export const NATIONAL_CREDIT_NOTE_TYPE = "91";
export const EXPORT_CREDIT_NOTE_TYPE = "02";

/** 13.3.3 «Moneda (ISO 4217) @currencyID» (workbook «13.3.3 Moneda (ISO 4217) @currencyID1.xlsx»): the codes, both column groups of the sheet. */
export const CURRENCIES: readonly string[] = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BOV",
  "BRL", "BSD", "BTN", "BWP", "BYR", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUC", "CUP", "CVE",
  "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD",
  "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD",
  "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRO", "MUR", "MVR", "MWK", "MXN",
  "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD",
  "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLL", "SOS", "SRD", "SSP", "STD", "SVC", "SYP", "SZL", "THB", "TJS", "TMT",
  "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UZS", "VEF", "VES", "VND", "VUV", "WST", "XAF", "XAG",
  "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWL",
];

export const conceptName = (kind: "credit" | "debit", code: string): string | undefined =>
  (kind === "credit" ? CREDIT_NOTE_CONCEPTS : DEBIT_NOTE_CONCEPTS).find((c) => c.code === code)?.name;
