import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { PACK_PROCESSES } from "./processes/pack";
import { PICK_PROCESSES } from "./processes/pick";
import { PUTAWAY_PROCESSES } from "./processes/putaway";
import { SETTINGS_PROCESSES } from "./processes/settings";

// Features of the warehouse module (plan 2B.2 Task 29, PG §4.4) and its menu. Labels are i18n keys. The level-1 items are the four sections
// (entity types spec §2.4, §9.2). Task 29.1 brings the alistamientos and the Parámetros de bodega with no screen yet: the items (Bodega ›
// Documentos «Alistamientos», «Empaques», Parámetros «Reglas de ubicación», «Configuración», Reportes «Pendientes por alistar») and their
// pages are Task 29.4's; Task 29.3 adds the empaques and the put-away (rules, suggestion, confirmation) with no screen yet. Until then
// MENU_SHARED declares the module's processes, so no process is reachable without a menu item that could hide it (there is none to hide).

export const FEATURE_PICKING = "warehouse.picking";
export const FEATURE_SETTINGS = "warehouse.settings";
export const FEATURE_PACKING = "warehouse.packing";
export const FEATURE_PUTAWAY = "warehouse.putaway";

/** Processes no menu item guards yet (ModuleDef.menuShared); Task 29.4 replaces this by the items of its screens. */
export const MENU_SHARED = ["warehouse.pick.", "warehouse.pick_line.", "warehouse.settings.", "warehouse.pack.", "warehouse.pack_package.", "warehouse.putaway_rule.", "warehouse.putaway."];

export const NAVIGATION: NavItem[] = menuSections("warehouse");

export const FEATURES: FeatureDef[] = [
  { id: FEATURE_PICKING, label: "feature.warehouse.picking", processes: PICK_PROCESSES.map((p) => p.id), entities: ["warehouse.pick", "warehouse.pick_line"], nav: [] },
  { id: FEATURE_PACKING, label: "feature.warehouse.packing", processes: PACK_PROCESSES.map((p) => p.id), entities: ["warehouse.pack", "warehouse.pack_package"], nav: [] },
  { id: FEATURE_PUTAWAY, label: "feature.warehouse.putaway", processes: PUTAWAY_PROCESSES.map((p) => p.id), entities: ["warehouse.putaway_rule"], nav: [] },
  { id: FEATURE_SETTINGS, label: "feature.warehouse.settings", processes: SETTINGS_PROCESSES.map((p) => p.id), entities: ["warehouse.settings"], nav: [] },
];
