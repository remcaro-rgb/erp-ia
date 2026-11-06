import { HOME_CHARTS, HOME_KPIS } from "./home";
import { defineModule, type ModuleDef } from "@erp/kernel";
import { SALES_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION } from "./features";
import { DELIVERY_PROCESSES, DELIVERY_SHIPPED, DELIVERY_VOIDED, deliveryHooks, onInvoiceAnnulled, onInvoiceIssued, onMovementPosted, onSaleIssueRefused } from "./processes/delivery";
import { ORDER_CANCELLED, ORDER_CONFIRMED, ORDER_CREATED, ORDER_PROCESSES, orderHooks } from "./processes/order";
import { deliveryRecordTemplate, orderRecordTemplate, returnRecordTemplate } from "./print";
import { PRICING_PROCESSES } from "./processes/pricing";
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
 * devolución back to received with the reason.
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
  processes: [...PRICING_PROCESSES, ...ORDER_PROCESSES, ...DELIVERY_PROCESSES, ...RETURN_PROCESSES],
  features: FEATURES,
  // Its Inicio cards (plan 2B Task 26).
  homeKpis: HOME_KPIS,
  homeCharts: HOME_CHARTS,
  events: {
    emits: [ORDER_CREATED, ORDER_CONFIRMED, ORDER_CANCELLED, DELIVERY_SHIPPED, DELIVERY_VOIDED, RETURN_RECEIVED, RETURN_VOIDED],
    consumes: {
      "inventory.movement.posted": onMovementPosted,
      // Inventory could not issue a despacho / take back a devolución's stock: the document goes back with the reason (Task 14 review).
      "inventory.sale_issue.refused": onSaleIssueRefused,
      "inventory.sale_return_void.refused": onReturnVoidRefused,
      // What an issued invoice billed of each entrega line (Task 16: sales never imports invoicing; it reads invoicing's published view).
      "invoicing.invoice.issued": onInvoiceIssued,
      // An invoice voided by its accepted annulment note (Task 18): the entregas get back what it invoiced.
      "invoicing.invoice.annulled": onInvoiceAnnulled,
    },
  },
  navigation: NAVIGATION,
  menuShared: MENU_SHARED,
  // What the assistant's confirmation card tells about the entregas (plan 2B Task 25): what this module's consumer does with an issued invoice.
  effects: { "invoicing.invoice.issued": ["sales.effects.invoice_issued"] },
  // The lifecycle of the pedido (entity types spec §5): Grabar runs the checks; it numbers PED- on save.
  typedHooks: { "sales.order": orderHooks, "sales.delivery": deliveryHooks, "sales.return": returnHooks },
  // What a pedido and an entrega print with when the company chose no template of its own (Task 14b).
  printTemplates: { "sales.order": { record: orderRecordTemplate }, "sales.delivery": { record: deliveryRecordTemplate }, "sales.return": { record: returnRecordTemplate } },
});

export { DELIVERY_STAGES, ORDER_STAGES, RETURN_STAGES, SALES_ENTITIES } from "./entities";
export type { DeliveryStage, OrderStage } from "./entities";
export { DELIVERY_SHIPPED, DELIVERY_SOURCE, DELIVERY_VOIDED } from "./processes/delivery";
export { RETURN_RECEIVED, RETURN_VOIDED } from "./processes/return";
export { ORDER_CANCELLED, ORDER_CONFIRMED, ORDER_CREATED, ORDER_LINE_SOURCE } from "./processes/order";
export { choosePrice, lineDiscount, resolveLineDiscount, resolveLinePrice } from "./price";
export type { ListCandidate, PriceCandidates, PriceRequest, PriceSource, ResolvedPrice } from "./price";
export { assertSaleReady, readinessReasons } from "./readiness";
export type { SaleParty, SaleProduct } from "./readiness";
