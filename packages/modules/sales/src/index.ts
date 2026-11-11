import { HOME_CHARTS, HOME_KPIS } from "./home";
import { defineModule, type ModuleDef } from "@erp/kernel";
import { SALES_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION } from "./features";
import { DELIVERY_PROCESSES, DELIVERY_SHIPPED, DELIVERY_VOIDED, deliveryHooks, onInvoiceAnnulled, onInvoiceIssued, onMovementPosted, onReReservation, onReservationAllocated, onSaleIssueAllocated, onSaleIssueRefused, RESERVATION_ALLOCATED } from "./processes/delivery";
import { ORDER_CANCELLED, ORDER_CONFIRMED, ORDER_CREATED, ORDER_PROCESSES, orderHooks } from "./processes/order";
import { ORDER_OWNER_PROCESSES } from "./processes/order-owner";
import { commissionRecordTemplate, deliveryRecordTemplate, orderRecordTemplate, returnRecordTemplate } from "./print";
import { SALES_REPORT_PROCESSES, SALES_REPORTS } from "./reports/commissions";
import { PRICING_PROCESSES } from "./processes/pricing";
import { COMMISSION_ACCRUED, COMMISSION_DUE, COMMISSION_PROCESSES, COMMISSION_REVERSED, commissionHooks, onAdvanceApplied, onAdvanceUnapplied, onCommissionDue, onNoteIssued, onPaymentReceived, onPaymentVoided } from "./processes/commission";
import { SALES_POSTING_RULES } from "./rules";
import { COMMISSION_PLAN_PROCESSES, commissionPlanHooks } from "./processes/commission-plan";
import { onReturnVoidRefused, RETURN_PROCESSES, RETURN_RECEIVED, RETURN_VOIDED, returnHooks } from "./processes/return";

/**
 * The sales module (design §8, §8.1, plan 2B Task 12): the price a sale line takes (the customer's price list, the company's default list,
 * the product's list price) and the commercial terms of each customer. The price lists are core's; the quotes are crm's (design §8 table) and
 * price their lines with `resolveLinePrice`. Pedidos (Task 13): sales.order, confirmed into sales.order.confirmed and cancelled into
 * sales.order.cancelled; the inventory module consumes both by event name to reserve and release the stock (sales never calls inventory,
 * rule 3), the crm module the first to mark the oportunidad won. Entregas and devoluciones (Task 14): sales.delivery.shipped / .voided and
 * sales.return.received / .voided, which inventory consumes by name to issue, re-enter or give back the stock (costing values it and sends
 * the cost of sales to the ledger); sales consumes inventory.movement.posted by name to record which entrega lines inventory has issued,
 * and inventory's refusals (inventory.sale_issue.refused, inventory.sale_return_void.refused) to put the entrega back to open or the
 * devolución back to received with the reason. A voided entrega may ask inventory to reserve the stock again for the pedido (Task 43:
 * a flag on sales.delivery.voided); sales consumes inventory.delivery_reservation.restored to record the outcome on the entrega.
 *
 * Two reads are not declared in `dependsOn` (published views, read only, rule 3): a pedido's bodega is checked in inventory's
 * inventory.v_warehouses, and sales.order.from_quote reads the accepted cotización in crm's crm.v_quote_offers / v_quote_offer_lines
 * (migration 0084). crm depends on sales (its quotes are priced here), so sales cannot depend on crm; without crm (or inventory) for the
 * company those views show nothing and the processes refuse the cotización (or the bodega) as not found. An entrega's ship reads the stock
 * of its bodega in inventory's published functions inventory.sale_stock and inventory.source_reservations (migration 0085). Invoicing (Task
 * 16) depends on core only and reads sales through sales' published views (sales.v_invoice_order_lines, v_invoice_delivery_lines,
 * sales.lock_deliveries_for_invoice, migration 0093); sales reads back what was invoiced through invoicing's published views and function
 * (invoicing.v_invoiced_delivery_lines, delivery_invoiced, v_order_invoiced, v_open_invoices, migration 0092) for invoiced_qty, Anular and the
 * credit exposure. Neither module imports the other; without invoicing for the company those views are empty.
 */
export const sales: ModuleDef = defineModule({
  id: "sales",
  version: "0.1.0",
  dependsOn: ["core"],
  icon: "shopping-cart",
  entities: SALES_ENTITIES,
  // sales.order.reassign (Task 39): the «all orders» permission of the owner isolation (migration 0139) and the owner change.
  // Commissions (Task 30.1): the plans, the bases of an issued invoice (sales.commission.compute, from the invoicing.invoice.issued consumer)
  // and sales.commission.consult_all, the «all commissions» permission of the record rule (migration 0156).
  // Task 30.2: sales.commission.accrue, from sales.commission.due (on_invoice) and the payments events (on_collection), posts the provision.
  // Task 30.3: sales.commission.reverse and sales.commission.adjust_for_note, from the credit notes, the annulment and the collection voids.
  // Task 30.4: sales.commission.consult, the commission's record (read only).
  processes: [...PRICING_PROCESSES, ...ORDER_PROCESSES, ...ORDER_OWNER_PROCESSES, ...DELIVERY_PROCESSES, ...RETURN_PROCESSES, ...COMMISSION_PLAN_PROCESSES, ...COMMISSION_PROCESSES, ...SALES_REPORT_PROCESSES],
  // Task 30.4: «Comisiones por vendedor» (sales.report.commissions: by payee, period and status; exported like every report, rule 20).
  reports: SALES_REPORTS,
  // The commission provision (plan 2B.2 Task 30.2, PG §5.4, RG-13): the two roles the country pack maps by payee kind (dimension
  // payee_kind:employee | payee_kind:agent), and the rules of the accrual and its reversal (rules/, twins of accounting's defaults).
  accountRoles: ["commission_expense", "commissions_payable"],
  postingRules: SALES_POSTING_RULES,
  features: FEATURES,
  // Its Inicio cards (plan 2B Task 26).
  homeKpis: HOME_KPIS,
  homeCharts: HOME_CHARTS,
  events: {
    // sales.commission.due { invoiceId, basis } (Task 30.1): an issued invoice wrote commission bases; Task 30.2's consumer accrues them.
    // sales.commission.accrued (Task 30.2): a commission documento, posted by the rule commission-accrued.
    // sales.commission.reversed (Task 30.3): a commission reversed, its entry reversed by the rule commission-reversed (reverseOf).
    emits: [ORDER_CREATED, ORDER_CONFIRMED, ORDER_CANCELLED, DELIVERY_SHIPPED, DELIVERY_VOIDED, RETURN_RECEIVED, RETURN_VOIDED, COMMISSION_DUE, COMMISSION_ACCRUED, COMMISSION_REVERSED],
    consumes: {
      "inventory.movement.posted": onMovementPosted,
      // Inventory could not issue a despacho / take back a devolución's stock: the document goes back with the reason (Task 14 review).
      "inventory.sale_issue.refused": onSaleIssueRefused,
      // What the issue took of each lot and serial (Task 28.3): recorded on the entrega lines (sales.delivery_line_lots).
      "inventory.sale_issue.allocated": onSaleIssueAllocated,
      "inventory.sale_return_void.refused": onReturnVoidRefused,
      // The outcome of the re-reservation a voided entrega asked for (Task 43): recorded on the entrega, «Reserva al anular».
      "inventory.delivery_reservation.restored": onReReservation,
      // A confirmed alistamiento of the warehouse module, as inventory allocated it (Task 29.2, RG-8): an open entrega with the picked lines
      // (when the alistamiento asks for one). Sales reacts to inventory's answer, never to the pick, and keeps dependsOn ["core"].
      [RESERVATION_ALLOCATED]: onReservationAllocated,
      // What an issued invoice billed of each entrega line (Task 16: sales never imports invoicing; it reads invoicing's published view),
      // then the commission bases of its lines billed from a pedido (Task 30.1: a second, separate run).
      "invoicing.invoice.issued": onInvoiceIssued,
      // An invoice voided by its accepted annulment note (Task 18): the entregas get back what it invoiced; then its commissions are
      // reversed (Task 30.3, a second run).
      "invoicing.invoice.annulled": onInvoiceAnnulled,
      // The commission reversals (Task 30.3): a credit note reduces the bases of its lines (the annulment reverses them all); a voided
      // receipt or an undone advance application reverses the commissions it accrued.
      "invoicing.note.issued": onNoteIssued,
      "payments.payment.voided": onPaymentVoided,
      "payments.advance.unapplied": onAdvanceUnapplied,
      // The commissions (Task 30.2, RG-12): its own sales.commission.due accrues an on_invoice invoice in a run of its own (a posting failure
      // retries only that event); a receipt or an advance application accrues the on_collection bases of the invoices it settles.
      "sales.commission.due": onCommissionDue,
      "payments.received": onPaymentReceived,
      "payments.advance.applied": onAdvanceApplied,
    },
  },
  navigation: NAVIGATION,
  menuShared: MENU_SHARED,
  // What the assistant's confirmation card tells about the entregas (plan 2B Task 25): what this module's consumer does with an issued invoice.
  effects: {
    "inventory.movement.posted": ["sales.effects.movement_posted"],
    "inventory.sale_issue.refused": ["sales.effects.issue_refused"],
    "inventory.sale_issue.allocated": ["sales.effects.lots_recorded"],
    "inventory.sale_return_void.refused": ["sales.effects.return_void_refused"],
    "inventory.delivery_reservation.restored": ["sales.effects.re_reserve_recorded"],
    [RESERVATION_ALLOCATED]: ["sales.effects.pick_delivery"],
    "invoicing.invoice.issued": ["sales.effects.invoice_issued", "sales.effects.commission_bases"],
    "invoicing.invoice.annulled": ["sales.effects.invoice_annulled", "sales.effects.commission_reversal"],
    "invoicing.note.issued": ["sales.effects.commission_note"],
    "payments.payment.voided": ["sales.effects.commission_reversal"],
    "payments.advance.unapplied": ["sales.effects.commission_reversal"],
    "sales.commission.due": ["sales.effects.commission_accrual"],
    "payments.received": ["sales.effects.commission_accrual"],
    "payments.advance.applied": ["sales.effects.commission_accrual"],
  },
  // The lifecycle of the pedido (entity types spec §5): Grabar runs the checks; it numbers PED- on save.
  typedHooks: { "sales.order": orderHooks, "sales.delivery": deliveryHooks, "sales.return": returnHooks, "sales.commission_plan": commissionPlanHooks, "sales.commission": commissionHooks },
  // What a pedido, an entrega, a devolución and a comisión (Task 30.4) print with when the company chose no template of its own (Task 14b).
  printTemplates: { "sales.order": { record: orderRecordTemplate }, "sales.delivery": { record: deliveryRecordTemplate }, "sales.return": { record: returnRecordTemplate }, "sales.commission": { record: commissionRecordTemplate } },
});

export { COMMISSION_BASES, COMMISSION_STAGES, DELIVERY_STAGES, ORDER_STAGES, PAYEE_KINDS, RETURN_STAGES, SALES_ENTITIES } from "./entities";
export type { CommissionBasis, DeliveryStage, OrderStage, PayeeKind } from "./entities";
export { COMMISSION_ACCRUED, COMMISSION_DUE, COMMISSION_REVERSED } from "./processes/commission";
export { SALES_POSTING_RULES } from "./rules";
export { DELIVERY_SHIPPED, DELIVERY_SOURCE, DELIVERY_VOIDED } from "./processes/delivery";
export { RETURN_RECEIVED, RETURN_VOIDED } from "./processes/return";
export { ORDER_CANCELLED, ORDER_CONFIRMED, ORDER_CREATED, ORDER_LINE_SOURCE } from "./processes/order";
export { choosePrice, lineDiscount, resolveLineDiscount, resolveLinePrice } from "./price";
export type { ListCandidate, PriceCandidates, PriceRequest, PriceSource, ResolvedPrice } from "./price";
export { assertSaleReady, readinessReasons } from "./readiness";
export type { SaleParty, SaleProduct } from "./readiness";
