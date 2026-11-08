import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { PAYMENT_PROCESSES } from "./consumers/payments";
import { AUTO_PROCESSES } from "./processes/auto";
import { EINVOICE_PROCESSES } from "./processes/einvoice";
import { INVOICE_PROCESSES } from "./processes/invoice";
import { NOTE_PROCESSES } from "./processes/note";
import { PENDING_PROCESSES } from "./processes/pending";
import { SETTINGS_PROCESSES } from "./processes/settings";

// Features of the invoicing module (design §5.12, §8) and its menu. Labels are i18n keys. Facturas under Documentos (the invoice's taxes and
// the recommendations of the automatic invoices behind it), Por facturar under Reportes (OD-2 manual) and Parámetros de facturación under
// Parámetros. The pages are Task 20 (facturas, por facturar) and Task 19 (parámetros). MENU_SHARED lists what no screen owns: the automatic
// creation and its recommendations, which only the consumers of sales' events run (origin event), and the steps of the DIAN submission.
// The credit and debit notes (Task 18) live under Facturas (their pages are Task 20).

/** Processes no menu item guards (ModuleDef.menuShared). */
export const MENU_SHARED = [
  "invoicing.invoice.auto_create", "invoicing.invoice.recommend",
  // The DIAN submission's own steps (Task 17): only the consumer and the e-invoice workflow run them (origin event).
  "invoicing.einvoice_submission.request", "invoicing.einvoice_submission.record", "invoicing.einvoice_submission.document", "invoicing.invoice.dian_result",
  // Task 18: the verdict of a note (origin event) and the annulment note, which runs only nested in Anular of the invoice.
  "invoicing.note.dian_result", "invoicing.note.issue_annulment",
  // Task 19: the PDF of an accepted document, stored by the e-invoice workflow (origin event).
  "invoicing.einvoice_submission.store_pdf",
  // Task 23: what the recibos de caja settled of each invoice, recorded by the consumer of payments' events (origin event).
  "invoicing.invoice.record_payments",
];

export const NAVIGATION: NavItem[] = menuSections("invoicing", {
  documentos: [
    { id: "invoicing.invoices", label: "nav.invoicing.invoices", href: "/invoicing/invoices", icon: "receipt", feature: "invoicing.invoices", entity: "invoicing.invoice", runs: ["invoicing.invoice_tax.", "invoicing.invoice_recommendation.", "invoicing.einvoice_submission.", "invoicing.note.", "invoicing.note_line.", "invoicing.note_tax."] },
    // Task 20 (prototype 2B: Documentos › Notas crédito y débito): the notes' own grid; they are written from their invoice.
    { id: "invoicing.notes", label: "nav.invoicing.notes", href: "/invoicing/notes", icon: "file-minus", feature: "invoicing.invoices", entity: "invoicing.note", runs: ["invoicing.note_line.", "invoicing.note_tax."] },
  ],
  reportes: [
    { id: "invoicing.pending", label: "nav.invoicing.pending", href: "/invoicing/pending", icon: "list-checks", feature: "invoicing.invoices", entity: "invoicing.pending_line", runs: ["invoicing.invoice.from_orders"] },
  ],
  parametros: [
    { id: "invoicing.settings", label: "nav.invoicing.settings", href: "/invoicing/settings", icon: "sliders", feature: "invoicing.settings", entity: "invoicing.settings", runs: ["invoicing.certificate.", "invoicing.software_pin.", "invoicing.dian_checklist.", "invoicing.dian_defaults.", "core.document_sequence.register"] },
  ],
});

/** Items of the bar whose gate is `feature`. */
const nav = (feature: string) => NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

const ids = (processes: { id: string }[]) => processes.map((p) => p.id);

export const FEATURES: FeatureDef[] = [
  {
    id: "invoicing.invoices",
    label: "feature.invoicing.invoices",
    processes: [...ids(INVOICE_PROCESSES), ...ids(NOTE_PROCESSES), ...ids(AUTO_PROCESSES), ...ids(EINVOICE_PROCESSES), ...ids(PENDING_PROCESSES), ...ids(PAYMENT_PROCESSES)],
    entities: ["invoicing.invoice", "invoicing.invoice_line", "invoicing.invoice_tax", "invoicing.invoice_recommendation", "invoicing.einvoice_submission", "invoicing.note", "invoicing.note_line", "invoicing.note_tax", "invoicing.pending_line"],
    nav: nav("invoicing.invoices"),
  },
  {
    id: "invoicing.settings",
    label: "feature.invoicing.settings",
    processes: ids(SETTINGS_PROCESSES),
    entities: ["invoicing.settings", "invoicing.dian_check"],
    nav: nav("invoicing.settings"),
  },
];
