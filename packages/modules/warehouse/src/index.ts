import { defineModule, type ModuleDef } from "@erp/kernel";
import { WAREHOUSE_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION } from "./features";
import { MOVEMENT_POSTED, onMovementPosted, onOrderCancelled, onOrderConfirmed, onReservationAllocated, ORDER_CANCELLED, ORDER_CONFIRMED, RESERVATION_ALLOCATED } from "./processes/consumers";
import { PACK_PROCESSES, packHooks } from "./processes/pack";
import { PICK_CONFIRMED, PICK_PROCESSES, pickHooks } from "./processes/pick";
import { PUTAWAY_CONFIRMED, PUTAWAY_PROCESSES } from "./processes/putaway";
import { SETTINGS_PROCESSES } from "./processes/settings";
import { packRecordTemplate } from "./print";

/**
 * The warehouse module «Bodega» (plan 2B.2 Task 29, Part G design PG §4; owner items 151, 153, 164): the alistamiento (pick list) of a
 * confirmed pedido and the Parámetros de bodega. Bins are inventory locations (§22.31, item 151): the module keeps no stock and no bins of
 * its own; it reads inventory's published views (stock per bucket, lots, ubicaciones, tracking) and sales' sales.v_pick_order_lines, and
 * talks to both by event (rule 3):
 *   sales.order.confirmed → an alistamiento proposed by FEFO, then most stock (auto_pick_on_confirm);
 *   warehouse.pick.confirmed → inventory allocates the reservations (inventory.reservation.allocate), moving no stock (RG-7);
 *   inventory.reservation.allocated → the alistamiento records the answer (short: back to «En proceso»);
 *   sales.order.cancelled → its alistamientos are voided;
 *   inventory.movement.posted (a receipt) → the «por ubicar» recommendation when a Regla de ubicación places it elsewhere (Task 29.3);
 *   warehouse.putaway.confirmed → inventory relocates the stock between ubicaciones of the bodega (inventory.relocation.post, no cost).
 * An alistamiento confirmed may be packed (warehouse.pack, EMP-, printed as the «Lista de empaque»); packing gates nothing.
 * A company that never bought the module parks the confirmation `not_entitled:warehouse`; buying it replays the event and makes no
 * alistamiento for an old pedido, nor asks to put away an old receipt (RG-10). The entrega from the alistamiento is Task 29.2, packing and
 * put-away 29.3, the screens 29.4.
 */
export const warehouse: ModuleDef = defineModule({
  id: "warehouse",
  version: "0.1.0",
  dependsOn: ["core", "inventory"],
  icon: "package",
  entities: WAREHOUSE_ENTITIES,
  processes: [...PICK_PROCESSES, ...PACK_PROCESSES, ...PUTAWAY_PROCESSES, ...SETTINGS_PROCESSES],
  features: FEATURES,
  events: {
    emits: [PICK_CONFIRMED, PUTAWAY_CONFIRMED],
    consumes: {
      [ORDER_CONFIRMED]: onOrderConfirmed,
      [ORDER_CANCELLED]: onOrderCancelled,
      [RESERVATION_ALLOCATED]: onReservationAllocated,
      [MOVEMENT_POSTED]: onMovementPosted,
    },
  },
  navigation: NAVIGATION,
  menuShared: MENU_SHARED,
  // What the assistant's confirmation card tells about the alistamientos (plan 2B Task 25, Task 50.3): what each consumer does.
  effects: {
    [ORDER_CONFIRMED]: ["warehouse.effects.order_pick"],
    [ORDER_CANCELLED]: ["warehouse.effects.order_pick_void"],
    [RESERVATION_ALLOCATED]: ["warehouse.effects.allocation_recorded"],
    [MOVEMENT_POSTED]: ["warehouse.effects.putaway_notify"],
  },
  typedHooks: { "warehouse.pick": pickHooks, "warehouse.pack": packHooks },
  // What an empaque prints with when the company chose no template of its own: the «Lista de empaque» (print.ts).
  printTemplates: { "warehouse.pack": { record: packRecordTemplate } },
});

export { WAREHOUSE_ENTITIES, PICK_STAGES, PACK_STAGES, ALLOCATION_STATUSES, pickEntity, pickLineEntity, packEntity, packPackageEntity, putawayRuleEntity, warehouseSettingsEntity } from "./entities";
export type { AllocationStatus, PackStage, PickStage } from "./entities";
export { FEATURE_PACKING, FEATURE_PICKING, FEATURE_PUTAWAY, FEATURE_SETTINGS } from "./features";
export { PICK_CONFIRMED, PICK_PROCESSES } from "./processes/pick";
export { PACK_PROCESSES } from "./processes/pack";
export { PUTAWAY_BASES, PUTAWAY_CONFIRMED, PUTAWAY_PROCESSES } from "./processes/putaway";
export { SETTINGS_PROCESSES } from "./processes/settings";
export { onMovementPosted, onOrderCancelled, onOrderConfirmed, onReservationAllocated } from "./processes/consumers";
export { PACK_PRINT_FIELDS, PACK_PRINT_LINE_COLUMNS, packRecordTemplate } from "./print";
