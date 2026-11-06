import { ADJUSTMENT_PROCESSES } from "./adjustment";
import { COUNT_PROCESSES } from "./count";
import { MOVEMENT_PROCESSES } from "./movement";
import { RESERVATION_PROCESSES } from "./reservation";
import { SALE_DELIVERY_PROCESSES } from "./sales-deliveries";
import { TRANSFER_PROCESSES } from "./transfer";
import { WAREHOUSE_PROCESSES } from "./warehouse";

/** Every process the inventory module declares (the loader adds the generic lifecycle verbs it does not declare). */
export const INVENTORY_PROCESSES = [...WAREHOUSE_PROCESSES, ...MOVEMENT_PROCESSES, ...RESERVATION_PROCESSES, ...TRANSFER_PROCESSES, ...ADJUSTMENT_PROCESSES, ...COUNT_PROCESSES, ...SALE_DELIVERY_PROCESSES];
