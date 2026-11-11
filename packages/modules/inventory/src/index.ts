import { HOME_KPIS } from "./home";
import { defineModule, type ModuleDef } from "@erp/kernel";
import { INVENTORY_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION } from "./features";
import { INVENTORY_REPORTS } from "./reports/lot-trace";
import { INVENTORY_PROCESSES } from "./processes";
import { MOVEMENT_POSTED, MOVEMENT_VOIDED, movementHooks } from "./processes/movement";
import { countHooks } from "./processes/count";
import { lotHooks } from "./processes/lot";
import { serialHooks } from "./processes/serial";
import { DELIVERY_RESERVATION_RESTORED, onDeliveryShipped, onDeliveryVoided, onReturnReceived, onReturnVoided, SALE_ISSUE_ALLOCATED, SALE_ISSUE_REFUSED, SALE_RETURN_VOID_REFUSED } from "./processes/sales-deliveries";
import { INVENTORY_POSTING_RULES } from "./rules";
import { onOrderCancelled, onOrderConfirmed } from "./processes/sales-orders";
import { RESERVATION_ALLOCATED } from "./processes/reservation";
import { onPickConfirmed, PICK_CONFIRMED } from "./processes/warehouse-picks";
import { transferHooks } from "./processes/transfer";
import { locationHooks, warehouseHooks } from "./processes/warehouse";

/**
 * The inventory module (design §8, plan 2B Task 6): bodegas and ubicaciones, the stock per product and ubicación, the movements that
 * change it and the reservations that promise it. Other modules read the stock through `inventory.v_stock` and move it through the
 * events they emit (a delivery, a return), which their consumers turn into inventory.movement.post (origin event); nothing outside this
 * schema writes it (rule 3). The pedidos of sales reserve and release stock the same way: inventory consumes sales.order.confirmed and
 * sales.order.cancelled (processes/sales-orders.ts), and the entregas and devoluciones (Task 14, processes/sales-deliveries.ts):
 * sales.delivery.shipped posts the sale issue and uses up the reservation, sales.delivery.voided voids it, sales.return.received posts
 * the sale return at the issue's cost, sales.return.voided voids it. A voided entrega may also promise its stock back to the pedido's lines
 * (Task 43: the nested inventory.reservation.reserve_again, answered to sales as inventory.delivery_reservation.restored). Lots and serials (Task 28, OD-8): the lot and serial maestros and the tracking per product (processes/lot.ts, serial.ts, tracking.ts); picking and put-away are the warehouse module's (Task 29).
 *
 * One read is declared in `needs`, not `dependsOn` (costing depends on inventory; Task 41): an adjustment is valued at costing's weighted average of its bodega through the published
 * definer function costing.average_costs() (migrations 0073 and 0075; processes/common.ts productCosts). It is a read of a published
 * function, not a write (rule 3), and inventory does not require costing on: disabling costing is refused while inventory is enabled, but when the costing module is switched off for the company the
 * function returns nothing and the adjustment falls back to the standard cost (core.product_standard_costs). Likewise the Anular of a
 * receipt reads costing.movement_landed_costs() (migration 0086) and refuses `landed_costs_active` while a landed cost is allocated to it.
 */
export const inventory: ModuleDef = defineModule({
  id: "inventory",
  version: "0.1.0",
  dependsOn: ["core"],
  // Costing depends on inventory, so inventory cannot list it in dependsOn (load cycle): `needs` is no load-order edge (plan 2B Task 41, R41-1).
  needs: ["costing"],
  icon: "warehouse",
  entities: INVENTORY_ENTITIES,
  processes: INVENTORY_PROCESSES,
  features: FEATURES,
  // Its Inicio cards (plan 2B Task 26).
  homeKpis: HOME_KPIS,
  // The pedidos (Task 13), entregas and devoluciones (Task 14) of sales, by event name (processes/sales-orders.ts, sales-deliveries.ts).
  events: { emits: [MOVEMENT_POSTED, MOVEMENT_VOIDED, SALE_ISSUE_REFUSED, SALE_ISSUE_ALLOCATED, SALE_RETURN_VOID_REFUSED, DELIVERY_RESERVATION_RESTORED, RESERVATION_ALLOCATED], consumes: {
      "sales.order.confirmed": onOrderConfirmed,
      "sales.order.cancelled": onOrderCancelled,
      "sales.delivery.shipped": onDeliveryShipped,
      "sales.delivery.voided": onDeliveryVoided,
      "sales.return.received": onReturnReceived,
      "sales.return.voided": onReturnVoided,
    },
  },
  navigation: NAVIGATION,
  // «Trazabilidad de lotes» (Task 28.4, PG §3.6): the recall report over inventory.report.lot_trace.
  reports: INVENTORY_REPORTS,
  postingRules: INVENTORY_POSTING_RULES,
  menuShared: MENU_SHARED,
  // What the assistant's confirmation card tells about the stock (plan 2B Task 25): what this module's consumers do with each sales event.
  effects: {
    "sales.order.confirmed": ["inventory.effects.order_reserve"],
    "sales.order.cancelled": ["inventory.effects.order_release"],
    "sales.delivery.shipped": ["inventory.effects.delivery_issue"],
    "sales.delivery.voided": ["inventory.effects.delivery_reentry", "inventory.effects.delivery_reserve_again"],
    "sales.return.received": ["inventory.effects.return_reentry"],
    "sales.return.voided": ["inventory.effects.return_void"],
  },
  // The lifecycle of the maestros and the movement (entity types spec §5): Grabar runs the update checks; a movement numbers on save and
  // never changes once it is in the stock.
  typedHooks: {
    "inventory.warehouse": warehouseHooks,
    "inventory.location": locationHooks,
    "inventory.movement": movementHooks,
    "inventory.transfer": transferHooks,
    "inventory.count": countHooks,
    "inventory.lot": lotHooks,
    "inventory.serial": serialHooks,
  },
});

export { INVENTORY_POSTING_RULES } from "./rules";
export { INVENTORY_ENTITIES, KIND_PREFIX, KIND_SIGN, MOVEMENT_KINDS, POSTABLE_KINDS } from "./entities";
export type { MovementKind } from "./entities";
export { postAdjustment } from "./processes/adjustment";
export { onOrderCancelled, onOrderConfirmed, ORDER_LINE_SOURCE } from "./processes/sales-orders";
export { RESERVATION_ALLOCATED } from "./processes/reservation";
export { onPickConfirmed, PICK_CONFIRMED } from "./processes/warehouse-picks";
export { DELIVERY_RESERVATION_RESTORED, SALE_ISSUE_ALLOCATED, SALE_ISSUE_REFUSED, SALE_RETURN_VOID_REFUSED } from "./processes/sales-deliveries";
export { applyStock, lockStockLegs, MOVEMENT_POSTED, MOVEMENT_VOIDED, postMovement } from "./processes/movement";
export type { MovementEvent, MovementEventLine, MovementInput, PostedMovement } from "./processes/movement";
export { DEFAULT_TRACKING, trackingOf } from "./processes/tracking";
export type { ProductTracking } from "./processes/tracking";
