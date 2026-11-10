import { ADJUSTMENT_PROCESSES } from "./adjustment";
import { COUNT_PROCESSES } from "./count";
import { LOT_PROCESSES } from "./lot";
import { MOVEMENT_PROCESSES } from "./movement";
import { RESERVATION_PROCESSES } from "./reservation";
import { SALE_DELIVERY_PROCESSES } from "./sales-deliveries";
import { SERIAL_PROCESSES } from "./serial";
import { TRACKING_PROCESSES } from "./tracking";
import { TRANSFER_PROCESSES } from "./transfer";
import { WAREHOUSE_PROCESSES } from "./warehouse";

/** Every process the inventory module declares (the loader adds the generic lifecycle verbs it does not declare). */
export const INVENTORY_PROCESSES = [...WAREHOUSE_PROCESSES, ...MOVEMENT_PROCESSES, ...RESERVATION_PROCESSES, ...TRANSFER_PROCESSES, ...ADJUSTMENT_PROCESSES, ...COUNT_PROCESSES, ...SALE_DELIVERY_PROCESSES, ...LOT_PROCESSES, ...SERIAL_PROCESSES, ...TRACKING_PROCESSES];
