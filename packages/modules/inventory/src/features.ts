import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { ADJUSTMENT_PROCESSES } from "./processes/adjustment";
import { COUNT_PROCESSES } from "./processes/count";
import { LOT_PROCESSES } from "./processes/lot";
import { MOVEMENT_PROCESSES } from "./processes/movement";
import { RESERVATION_PROCESSES } from "./processes/reservation";
import { SALE_DELIVERY_PROCESSES } from "./processes/sales-deliveries";
import { SERIAL_PROCESSES } from "./processes/serial";
import { TRACKING_PROCESSES } from "./processes/tracking";
import { TRANSFER_PROCESSES } from "./processes/transfer";
import { WAREHOUSE_PROCESSES } from "./processes/warehouse";

// Features of the inventory module (design §5.12, §8) and its menu. Labels are i18n keys. The level-1 items are the four sections
// (entity types spec §2.4, §9.2; plan 2B Task 10): Bodegas and Ubicaciones under Maestros; Movimientos, Transferencias and Conteos under
// Documentos; Existencias (the masked inventory.v_stock_levels) under Reportes; Lotes and Seriales under Maestros and Seguimiento por
// producto under Parámetros (Task 28.1). Each item names the entity whose screen it is and `runs`
// the other processes its screen runs: while an item is hidden for a caller (kernel.menu_access) those are refused to them too.
// MENU_SHARED lists what no screen owns: the reservations, which sales orders make and release through their events (Task 13), and the
// stock of the entregas and devoluciones, which only their events move (inventory.sale.*, Task 14).

/** Processes no menu item guards (ModuleDef.menuShared). */
export const MENU_SHARED = ["inventory.reservation.", "inventory.sale."];

export const NAVIGATION: NavItem[] = menuSections("inventory", {
  maestros: [
    { id: "inventory.warehouses", label: "nav.inventory.warehouses", href: "/inventory/warehouses", icon: "warehouse", feature: "inventory.warehouses", entity: "inventory.warehouse" },
    { id: "inventory.locations", label: "nav.inventory.locations", href: "/inventory/locations", icon: "map-pin", feature: "inventory.warehouses", entity: "inventory.location" },
    { id: "inventory.lots", label: "nav.inventory.lots", href: "/inventory/lots", icon: "package", feature: "inventory.stock", entity: "inventory.lot" },
    { id: "inventory.serials", label: "nav.inventory.serials", href: "/inventory/serials", icon: "tags", feature: "inventory.stock", entity: "inventory.serial" },
  ],
  documentos: [
    // Movimientos also registers ajustes (inventory.adjustment.post, step-up): an ajuste is a movement of its own kind.
    { id: "inventory.movements", label: "nav.inventory.movements", href: "/inventory/movements", icon: "arrow-left-right", feature: "inventory.stock", entity: "inventory.movement", runs: ["inventory.adjustment."] },
    { id: "inventory.transfers", label: "nav.inventory.transfers", href: "/inventory/transfers", icon: "truck", feature: "inventory.stock", entity: "inventory.transfer" },
    { id: "inventory.counts", label: "nav.inventory.counts", href: "/inventory/counts", icon: "clipboard-check", feature: "inventory.stock", entity: "inventory.count" },
  ],
  reportes: [
    { id: "inventory.stock", label: "nav.inventory.stock", href: "/inventory/stock", icon: "boxes", feature: "inventory.stock", entity: "inventory.stock_level" },
  ],
  parametros: [
    { id: "inventory.product_tracking", label: "nav.inventory.product_tracking", href: "/inventory/product-tracking", icon: "sliders", feature: "inventory.stock", entity: "inventory.product_tracking" },
  ],
});

/** Items of the bar whose gate is `feature`. */
const nav = (feature: string) => NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

const ids = (processes: { id: string }[]) => processes.map((p) => p.id);

export const FEATURES: FeatureDef[] = [
  {
    id: "inventory.warehouses",
    label: "feature.inventory.warehouses",
    processes: ids(WAREHOUSE_PROCESSES),
    entities: ["inventory.warehouse", "inventory.location"],
    nav: nav("inventory.warehouses"),
  },
  {
    id: "inventory.stock",
    label: "feature.inventory.stock",
    processes: [...ids(MOVEMENT_PROCESSES), ...ids(RESERVATION_PROCESSES), ...ids(TRANSFER_PROCESSES), ...ids(ADJUSTMENT_PROCESSES), ...ids(COUNT_PROCESSES), ...ids(SALE_DELIVERY_PROCESSES), ...ids(LOT_PROCESSES), ...ids(SERIAL_PROCESSES), ...ids(TRACKING_PROCESSES)],
    entities: [
      "inventory.movement", "inventory.movement_line", "inventory.stock_level", "inventory.reservation",
      "inventory.transfer", "inventory.transfer_line", "inventory.count", "inventory.count_line",
      "inventory.lot", "inventory.serial", "inventory.product_tracking", "inventory.reservation_allocation",
    ],
    nav: nav("inventory.stock"),
  },
];
