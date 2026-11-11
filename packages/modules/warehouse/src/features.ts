import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { PACK_PROCESSES } from "./processes/pack";
import { PICK_PROCESSES } from "./processes/pick";
import { PUTAWAY_PROCESSES } from "./processes/putaway";
import { SETTINGS_PROCESSES } from "./processes/settings";
import { REPORT_PROCESSES } from "./reports/pending-picks";

// Features of the warehouse module (plan 2B.2 Task 29, PG §4.4) and its menu. Labels are i18n keys. The level-1 items are the four sections
// (entity types spec §2.4, §9.2). Task 29.4 brings the screens: Bodega › Documentos «Alistamientos», «Empaques» and «Ubicar recibidos» (the
// put-away of a receipt, owner item 239), Reportes «Pendientes por alistar», Parámetros «Reglas de ubicación» and «Configuración». Each item
// names the entity whose screen it is or `runs` the processes its screen runs: while an item is hidden for a caller (kernel.menu_access) those
// are refused to them too. MENU_SHARED lists the two processes only events run (inventory's answer to a confirmed alistamiento and the
// «por ubicar» notice of a receipt), which no screen owns.

export const FEATURE_PICKING = "warehouse.picking";
export const FEATURE_SETTINGS = "warehouse.settings";
export const FEATURE_PACKING = "warehouse.packing";
export const FEATURE_PUTAWAY = "warehouse.putaway";

/** Processes no menu item guards (ModuleDef.menuShared): the ones only events run. */
export const MENU_SHARED = ["warehouse.pick.record_allocation", "warehouse.putaway.notify"];

export const NAVIGATION: NavItem[] = menuSections("warehouse", {
  documentos: [
    { id: "warehouse.picks", label: "nav.warehouse.picks", href: "/warehouse/picks", icon: "clipboard-check", feature: FEATURE_PICKING, entity: "warehouse.pick" },
    { id: "warehouse.packs", label: "nav.warehouse.packs", href: "/warehouse/packs", icon: "package", feature: FEATURE_PACKING, entity: "warehouse.pack" },
    { id: "warehouse.putaway", label: "nav.warehouse.putaway", href: "/warehouse/putaway", icon: "map-pin", feature: FEATURE_PUTAWAY, runs: ["warehouse.putaway."] },
  ],
  reportes: [
    { id: "warehouse.pending_picks", label: "nav.warehouse.pending_picks", href: "/warehouse/pending-picks", icon: "list", feature: FEATURE_PICKING, runs: ["warehouse.report.pending_picks"] },
  ],
  parametros: [
    { id: "warehouse.putaway_rules", label: "nav.warehouse.putaway_rules", href: "/warehouse/putaway-rules", icon: "sliders", feature: FEATURE_PUTAWAY, entity: "warehouse.putaway_rule" },
    { id: "warehouse.settings", label: "nav.warehouse.settings", href: "/warehouse/settings", icon: "settings", feature: FEATURE_SETTINGS, runs: ["warehouse.settings."] },
  ],
});

/** Items of the bar whose gate is `feature`. */
const nav = (feature: string) => NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

export const FEATURES: FeatureDef[] = [
  { id: FEATURE_PICKING, label: "feature.warehouse.picking", processes: [...PICK_PROCESSES, ...REPORT_PROCESSES].map((p) => p.id), entities: ["warehouse.pick", "warehouse.pick_line"], nav: nav(FEATURE_PICKING) },
  { id: FEATURE_PACKING, label: "feature.warehouse.packing", processes: PACK_PROCESSES.map((p) => p.id), entities: ["warehouse.pack", "warehouse.pack_package"], nav: nav(FEATURE_PACKING) },
  { id: FEATURE_PUTAWAY, label: "feature.warehouse.putaway", processes: PUTAWAY_PROCESSES.map((p) => p.id), entities: ["warehouse.putaway_rule"], nav: nav(FEATURE_PUTAWAY) },
  { id: FEATURE_SETTINGS, label: "feature.warehouse.settings", processes: SETTINGS_PROCESSES.map((p) => p.id), entities: ["warehouse.settings"], nav: nav(FEATURE_SETTINGS) },
];
