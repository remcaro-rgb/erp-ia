import type { DianChecklist, DianChecklistItem } from "@erp/kernel";

// The DIAN verification checklist (plan 2B Task 35, owner item 20 «Unconfirmed DIAN items», decided 2026-11-06): what the documents carry
// today that was written against the DIAN's annexes and the mock transport, never verified against the DIAN's habilitación. The company's
// admin ticks each row once they verified it there; the confirmation of the defaults, which the production guard reads, needs every row
// ticked. Fiscal content, so it lives in the pack (rule 5); the invoicing module reads it only through `packOf(ctx).einvoice.dianChecklist`.
//
// Adding a row: append it (or place it in its group) with `since = version + 1` and raise `version` to it. That clears the confirmation
// everywhere at once (the stored version no longer equals the list's), as it must: a new value is unverified. Removing or rewording a row
// is a copy edit; a removed key leaves an orphan tick that every read ignores. No row has a DIAN documentation link today: item 20 names
// none and a link made up would be a fabricated reference (R35-4); `docUrl` takes an https URL when one is known.

/** The eight groups of the list, in display order (headings: `invoicing.dian_checklist.groups.<group>`). */
export const DIAN_CHECKLIST_GROUPS = [
  "notes_documents", "signing_software", "dian_response", "taxes_amounts", "payment_buyers", "issuer_profile", "infrastructure", "reference_tables",
] as const;

const item = (key: string, group: (typeof DIAN_CHECKLIST_GROUPS)[number], es: string, en: string): DianChecklistItem => ({ key, group, since: 1, es, en });

export const DIAN_CHECKLIST: DianChecklist = {
  version: 1,
  items: [
    // 1. Notas y tipos de documento
    item("credit_note_type_91", "notes_documents",
      "El CreditNoteTypeCode nacional de las notas crédito es 91",
      "The national CreditNoteTypeCode of credit notes is 91"),
    item("export_customization_10", "notes_documents",
      "El CustomizationID de las facturas y notas de exportación es 10 (el ejemplo de la DIAN v1.9 usa 04 / 11)",
      "The CustomizationID of export invoices and notes is 10 (the DIAN v1.9 example uses 04 / 11)"),
    item("no_export_debit_type_code", "notes_documents",
      "Las notas débito de exportación no llevan DebitNoteTypeCode",
      "Export debit notes carry no DebitNoteTypeCode"),
    item("no_invoice_control_on_notes", "notes_documents",
      "Las notas crédito y débito no llevan la extensión InvoiceControl",
      "Credit and debit notes carry no InvoiceControl extension"),
    item("notes_resolution_row", "notes_documents",
      "Las notas reutilizan una fila de numeración con la forma de una resolución",
      "Notes reuse a numbering row shaped like a resolution"),
    // 2. Firma y software
    item("software_security_code_doc_number", "signing_software",
      "El tercer elemento del SoftwareSecurityCode es el número del documento (otro sistema usaba el NIT)",
      "The third element of the SoftwareSecurityCode is the document number (another system used the NIT)"),
    item("no_sts_qrcode", "signing_software",
      "Las DianExtensions no llevan sts:QRCode (el Anexo 1.8 o posterior puede exigirlo)",
      "The DianExtensions carry no sts:QRCode (Annex 1.8 or later may require it)"),
    item("signature_canonicalization", "signing_software",
      "La canonicalización de la firma es la escrita (tomada de otro sistema)",
      "The signature canonicalization is the one written (taken from another system)"),
    // 3. Respuesta de la DIAN y reenvío
    item("status_code_map", "dian_response",
      "El mapa de códigos de estado 00 / 66 / 90 / 98 / 99, y si el código 90 significa «nunca recibido»",
      "The status code map 00 / 66 / 90 / 98 / 99, and whether code 90 means «never received»"),
    item("getstatus_cufe_track_id", "dian_response",
      "GetStatus se consulta con el CUFE como trackId",
      "GetStatus is queried with the CUFE as trackId"),
    item("resend_rejected_same_number_cufe", "dian_response",
      "Un documento rechazado se reenvía con el mismo número y el mismo CUFE",
      "A rejected document is resent with the same number and the same CUFE"),
    item("async_zipkey_loss_in_doubt", "dian_response",
      "Si el set de pruebas asíncrono pierde el ZipKey, el envío queda en duda (submission_in_doubt)",
      "If the asynchronous test set loses the ZipKey, the submission is left in doubt (submission_in_doubt)"),
    item("poll_backoff", "dian_response",
      "La espera entre consultas de la respuesta: 20 consultas, cerca de 2,5 horas",
      "The wait between response polls: 20 polls, about 2.5 hours"),
    // 4. Impuestos e importes
    item("free_sample_tax_total", "taxes_amounts",
      "El TaxTotal y el AlternativeConditionPrice de las muestras gratis",
      "The TaxTotal and AlternativeConditionPrice of free samples"),
    item("per_unit_other_taxes", "taxes_amounts",
      "Los otros impuestos por unidad llevan PerUnitAmount y BaseUnitMeasure",
      "Per-unit other taxes carry PerUnitAmount and BaseUnitMeasure"),
    item("tax_exclusive_amount_excluded_zz", "taxes_amounts",
      "El TaxExclusiveAmount con líneas excluidas y con el tributo ZZ",
      "The TaxExclusiveAmount with excluded lines and with tax ZZ"),
    // 5. Medios de pago y compradores
    item("payment_means_subset", "payment_buyers",
      "Los medios de pago son un subconjunto de la tabla 13.3.4.2: 1, 10, 20, 42, 47, 48, 49, 71, ZZZ",
      "Payment means are a subset of table 13.3.4.2: 1, 10, 20, 42, 47, 48, 49, 71, ZZZ"),
    item("foreign_buyer_ids_digits", "payment_buyers",
      "Los documentos de compradores extranjeros se reducen a dígitos",
      "Foreign buyers' identification numbers are reduced to digits"),
    item("export_detection_country", "payment_buyers",
      "Una exportación se detecta cuando el país del cliente es distinto del país de la empresa",
      "An export is detected when the customer's country differs from the company's country"),
    // 6. Perfil fiscal del emisor
    item("issuer_fiscal_profile_builder_only", "issuer_profile",
      "El perfil fiscal del emisor (O-13 / R-99-PN, tributo 01 / ZZ, DANE) solo lo revisa el generador del documento",
      "The issuer's fiscal profile (O-13 / R-99-PN, tax scheme 01 / ZZ, DANE) is checked only by the document builder"),
    // 7. Infraestructura
    item("durable_runner_status_worlds", "infrastructure",
      "DurableRunner.status en los Worlds de Vercel y de Postgres solo se probó en el World en proceso",
      "DurableRunner.status on the Vercel and Postgres Worlds was tested only on the in-process World"),
    // 8. Tablas de referencia
    item("uvt_2023_2024_values", "reference_tables",
      "Los valores de la UVT de 2023 y 2024 se escribieron de memoria y no se usan",
      "The UVT values of 2023 and 2024 were written from memory and are unused"),
    item("other_tax_tariff_tables", "reference_tables",
      "Las tablas de tarifas de otros impuestos (bolsas, ICL, IBUA, ICUI, carbono) no están cargadas",
      "The tariff tables of other taxes (bags, ICL, IBUA, ICUI, carbon) are not loaded"),
  ],
};
