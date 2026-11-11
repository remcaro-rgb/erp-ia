import { HOME_CHARTS, HOME_KPIS } from "./home";
import { defineModule, type ModuleDef } from "@erp/kernel";
import { INVOICE_PAID, onAdvanceApplied, onAdvanceUnapplied, onPaymentReceived, onPaymentVoided } from "./consumers/payments";
import { INVOICING_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION } from "./features";
import { INVOICING_PROCESSES } from "./processes";
import { onDeliveryShipped, onOrderConfirmed, onSaleIssueAllocated } from "./processes/auto";
import { INVOICE_CREATED, INVOICE_ISSUED } from "./processes/common";
import {
  INVOICE_ACCEPTED, INVOICE_ANNULLED, INVOICE_REJECTED, NOTE_ACCEPTED, NOTE_REJECTED, onInvoiceIssued, onNoteIssued, onResubmitRequested, RESUBMIT_REQUESTED,
} from "./processes/einvoice";
import { invoiceHooks } from "./processes/invoice";
import { NOTE_ISSUED, noteHooks } from "./processes/note";
import { invoicePrintVariables, invoiceRecordTemplate, notePrintVariables, noteRecordTemplate } from "./pdf/invoice-template";
import { INVOICING_POSTING_RULES } from "./rules";

/**
 * The invoicing module (design §8, §8.1 step 5; plan 2B Task 16): sale invoices, their taxes (the country pack's computeTaxes, rule 5), the
 * issue («Emitir»: numbered by the DIAN resolution, CUFE, posted inline and strict, D8), the three ways invoices are created (OD-2) and the
 * void rules (OD-7: a Borrador is deleted, an issued invoice is annulled only by a credit note, Task 18). It reads sales and core only through
 * their published views and functions and consumes sales' events; sales reads what it invoiced through invoicing's published views and its
 * consumer of invoicing.invoice.issued (rule 3: neither module imports the other). The DIAN submission (Task 17): its own consumer of
 * invoicing.invoice.issued starts the e-invoice workflow (workflows/einvoice.workflow.ts) that signs, sends and polls the document and records
 * the verdict (dian_status, invoicing.invoice.accepted / .rejected); «Reintentar envío» sends a rejected one again. Notes (Task 18): credit
 * and debit notes of an accepted invoice (processes/note.ts), sent by the same workflow; Anular annuls an issued invoice by its full credit
 * note, and the invoice is voided once the DIAN accepts it (invoicing.invoice.annulled: sales gives back what it invoiced). Paid (Task 23,
 * consumers/payments.ts): it consumes payments' events by name and recomputes what the posted receipts settled of each invoice through
 * payments' published function; an invoice that becomes paid emits invoicing.invoice.paid (the CRM logs it on the deal).
 */
export const invoicing: ModuleDef = defineModule({
  id: "invoicing",
  version: "0.1.0",
  dependsOn: ["core"],
  icon: "receipt",
  entities: INVOICING_ENTITIES,
  processes: INVOICING_PROCESSES,
  features: FEATURES,
  // Its Inicio cards (plan 2B Task 26).
  homeKpis: HOME_KPIS,
  homeCharts: HOME_CHARTS,
  events: {
    emits: [INVOICE_CREATED, INVOICE_ISSUED, INVOICE_ACCEPTED, INVOICE_REJECTED, RESUBMIT_REQUESTED, NOTE_ISSUED, NOTE_ACCEPTED, NOTE_REJECTED, INVOICE_ANNULLED, INVOICE_PAID],
    consumes: {
      "sales.delivery.shipped": onDeliveryShipped,
      "sales.order.confirmed": onOrderConfirmed,
      // Task 28.4 review: an on_delivery invoice of a lot or serial entrega is issued once inventory's answer gave sales its lots.
      "inventory.sale_issue.allocated": onSaleIssueAllocated,
      // The DIAN submission (Task 17): one per issued invoice, and «Reintentar envío».
      [INVOICE_ISSUED]: onInvoiceIssued,
      [RESUBMIT_REQUESTED]: onResubmitRequested,
      // Task 18: one DIAN submission per issued note.
      [NOTE_ISSUED]: onNoteIssued,
      // Task 23: what the recibos de caja settled of each invoice (paid_amount, the paid stage), recomputed from payments' published facts.
      "payments.received": onPaymentReceived,
      "payments.payment.voided": onPaymentVoided,
      // Plan 2B.2 Task 36: an advance applied to invoices (and undone) settles them like a receipt: the same recomputation.
      "payments.advance.applied": onAdvanceApplied,
      "payments.advance.unapplied": onAdvanceUnapplied,
    },
  },
  navigation: NAVIGATION,
  menuShared: MENU_SHARED,
  // «Emitir» checks, numbers (on save) and posts the invoice, and the note, in the action (entity types spec §5).
  typedHooks: { "invoicing.invoice": invoiceHooks, "invoicing.note": noteHooks },
  postingRules: INVOICING_POSTING_RULES,
  // What the assistant's confirmation card tells about invoicing and the DIAN (plan 2B Task 25): what its consumers do with each event
  // (the automatic creation modes, the DIAN submission, the receipts), and what Anular and a note's Emitir do beyond their events.
  effects: {
    "sales.order.confirmed": ["invoicing.effects.order_auto_invoice"],
    "sales.delivery.shipped": ["invoicing.effects.delivery_auto_invoice"],
    "inventory.sale_issue.allocated": ["invoicing.effects.delivery_lots_issue"],
    [INVOICE_CREATED]: ["invoicing.effects.draft_created"],
    [INVOICE_ISSUED]: ["invoicing.effects.issue_dian"],
    [RESUBMIT_REQUESTED]: ["invoicing.effects.resubmit_dian"],
    "invoicing.invoice.void": ["invoicing.effects.void_annulment"],
    "invoicing.note.issue": ["invoicing.effects.note_dian"],
    // The event of a note's Emitir: the same line (the card lists a line said twice once).
    [NOTE_ISSUED]: ["invoicing.effects.note_dian"],
    "payments.received": ["invoicing.effects.payment_applied"],
    "payments.payment.voided": ["invoicing.effects.payment_voided"],
    "payments.advance.applied": ["invoicing.effects.advance_applied"],
    "payments.advance.unapplied": ["invoicing.effects.advance_unapplied"],
  },
  // Task 19: the graphic representation of the electronic invoice and its notes (CUFE / CUDE, the DIAN's QR, the numbering legend).
  printTemplates: { "invoicing.invoice": { record: invoiceRecordTemplate }, "invoicing.note": { record: noteRecordTemplate } },
  printVariables: { "invoicing.invoice": invoicePrintVariables, "invoicing.note": notePrintVariables },
});

export {
  DIAN_ENVIRONMENTS, DIAN_STATUSES, INVOICE_CREATION, INVOICE_ORIGINS, INVOICE_STAGES, INVOICING_ENTITIES, NOTE_KINDS, NOTE_STAGES, RECOMMENDATION_STATUSES, SUBMISSION_STATUSES, TAX_FAMILIES,
} from "./entities";
export type { InvoiceCreation, InvoiceStage } from "./entities";
export { INVOICE_CREATED, INVOICE_ISSUED, defaultRate, rateDiffers, RATE_WARNING_TOLERANCE } from "./processes/common";
export { INVOICE_ACCEPTED, INVOICE_ANNULLED, INVOICE_REJECTED, NOTE_ACCEPTED, NOTE_REJECTED, RESUBMIT_REQUESTED } from "./processes/einvoice";
export { NOTE_ISSUED } from "./processes/note";
export type { NoteOutput } from "./processes/note";
export { einvoiceSubmission } from "./workflows/einvoice.workflow";
export { softwarePinSecret } from "./einvoice-secrets";
export type { EInvoiceRunArgs, EInvoiceRunOutcome } from "./workflows/einvoice.workflow";
export { ANNULMENT_PROCESS } from "./processes/invoice";
export { INVOICE_PAID } from "./consumers/payments";
export type { InvoiceOutput } from "./processes/invoice";
export { INVOICING_POSTING_RULES } from "./rules";
