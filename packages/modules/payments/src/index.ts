import { HOME_CHARTS, HOME_KPIS } from "./home";
import { defineModule, type ModuleDef } from "@erp/kernel";
import { PAYMENTS_ENTITIES } from "./entities";
import { FEATURES, NAVIGATION } from "./features";
import { cashBoxHooks, MASTER_PROCESSES, methodHooks } from "./processes/masters";
import { ADVANCE_APPLIED, ADVANCE_PROCESSES, ADVANCE_UNAPPLIED, applicationHooks } from "./processes/advance";
import { PAYMENT_RECEIVED, PAYMENT_VOIDED, RECEIPT_PROCESSES, receiptHooks } from "./processes/receipt";
import { receiptRecordTemplate } from "./print";
import { PAYMENTS_POSTING_RULES } from "./rules";

/**
 * The payments module (design §8, §8.1 step 7, plan 2B Task 21): medios de pago and cajas (maestros), and the recibo de caja (documento that
 * posts) with what it applies to each invoice and the withholdings the customer practised. «Registrar pago» posts inline and strict
 * (payments.received, the 2A rule); Anular (step-up) reverses it (payments.payment.voided, rule reverseOf). It ships those two rules in its
 * manifest so each company gets one copy (the same as Tasks 16 and 18).
 *
 * Reads not declared in `dependsOn` (published views and functions, read only, rule 3): the invoices of an allocation through invoicing's
 * invoicing.v_receivable_invoices and invoicing.lock_invoices_for_payment (migration 0108); the customer through core.v_party_sales and
 * v_party_fiscal. Without invoicing for the company the view is empty and an allocation is refused as not found (an advance still works).
 * Invoicing reads back what the receipts settled through payments.v_invoice_allocations and the payload of payments.received (Task 23).
 */
export const payments: ModuleDef = defineModule({
  id: "payments",
  version: "0.1.0",
  dependsOn: ["core"],
  icon: "wallet",
  entities: PAYMENTS_ENTITIES,
  processes: [...MASTER_PROCESSES, ...RECEIPT_PROCESSES, ...ADVANCE_PROCESSES],
  features: FEATURES,
  // Its Inicio cards (plan 2B Task 26).
  homeKpis: HOME_KPIS,
  homeCharts: HOME_CHARTS,
  events: { emits: [PAYMENT_RECEIVED, PAYMENT_VOIDED, ADVANCE_APPLIED, ADVANCE_UNAPPLIED], consumes: {} },
  navigation: NAVIGATION,
  typedHooks: { "payments.method": methodHooks, "payments.cash_box": cashBoxHooks, "payments.receipt": receiptHooks, "payments.advance_application": applicationHooks },
  postingRules: PAYMENTS_POSTING_RULES,
  // The receipt rule posts the realized exchange difference (plan 2B.2 Task 34.5, FX §5): the roles accounting declares, named here too
  // because a module's rules may name only the kernel catalogue and its own roles (rule 4: modules never import one another).
  accountRoles: ["fx_gain", "fx_loss"],
  // What the assistant's confirmation card tells about a receipt (plan 2B Task 25); the ledger's own line comes from the posting provider.
  effects: {
    "payments.payment.receive": ["payments.effects.receipt_applied", "payments.effects.receipt_withholdings", "payments.effects.receipt_fx"],
    "payments.payment.void": ["payments.effects.receipt_voided"],
    // Aplicar anticipo a factura (plan 2B.2 Task 36, R36-12): the card names the ledger reclass; the ledger's own line comes from the posting provider.
    "payments.advance.apply": ["payments.effects.advance_applied"],
    "payments.advance.undo": ["payments.effects.advance_undone"],
  },
  // Imprimir of a receipt with no company template (Task 24b).
  printTemplates: { "payments.receipt": { record: receiptRecordTemplate } },
});

export { DOCUMENT_STATES, MAESTRO_STATES, METHOD_KINDS, PAYMENTS_ENTITIES, WITHHOLDING_KINDS } from "./entities";
export type { WithholdingKind } from "./entities";
export { ADVANCE_APPLIED, ADVANCE_UNAPPLIED, APPLICATION_PREFIX, applicationPlan, appliedPayload, unappliedPayload } from "./processes/advance";
export type { ApplicationOutput, ApplicationPlan } from "./processes/advance";
export { OPEN_INVOICES_FIELDS, payability, PAYMENT_RECEIVED, PAYMENT_VOIDED, PAYMENTS_REFUSAL_CODES, RECEIPT_PREFIX, receiptTotals, receivedPayload, voidedPayload } from "./processes/receipt";
export { RECEIPT_PRINT_FIELDS, RECEIPT_PRINT_LINE_COLUMNS, receiptRecordTemplate } from "./print";
export type { ReceivedPayload, ReceiptOutput } from "./processes/receipt";
export { PAYMENTS_POSTING_RULES } from "./rules";
