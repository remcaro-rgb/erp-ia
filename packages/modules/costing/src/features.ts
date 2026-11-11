import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { CONSULT_PROCESSES } from "./processes/consult";
import { COST_PROCESSES } from "./processes/cost";
import { LANDED_COST_PROCESSES } from "./processes/landed-cost";
import { VOID_PROCESSES } from "./processes/void";
import { SETTINGS_PROCESSES } from "./processes/settings";

// Features of the costing module (design §5.12, §8) and its menu. Labels are i18n keys. The level-1 items are the four sections (entity
// types spec §2.4, §9.2; plan 2B Task 10): Costos en destino under Documentos; Capas de costo (with the cost events behind them) and Costos
// pendientes (the open costing.cost_missing rows) under Reportes; Costeo (the method, step-up) under Parámetros. MENU_SHARED lists what no
// screen owns: the valuation of a movement, which only the consumer of inventory.movement.posted runs (origin event).

/** Processes no menu item guards (ModuleDef.menuShared). */
export const MENU_SHARED = ["costing.movement.cost", "costing.movement.void_cost"];

export const NAVIGATION: NavItem[] = menuSections("costing", {
  documentos: [
    { id: "costing.landed_costs", label: "nav.costing.landed_costs", href: "/costing/landed-costs", icon: "ship", feature: "costing.landed_costs", entity: "costing.landed_cost" },
  ],
  reportes: [
    { id: "costing.layers", label: "nav.costing.layers", href: "/costing/layers", icon: "layers", feature: "costing.costs", entity: "costing.cost_layer", runs: ["costing.cost_event."] },
    { id: "costing.missing", label: "nav.costing.missing", href: "/costing/missing", icon: "alert-triangle", feature: "costing.costs", entity: "costing.cost_missing" },
  ],
  parametros: [
    { id: "costing.settings", label: "nav.costing.settings", href: "/costing/settings", icon: "sliders", feature: "costing.settings", entity: "costing.settings", runs: ["costing.unknown_cost."] },
  ],
});

/** Items of the bar whose gate is `feature`. */
const nav = (feature: string) => NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

const ids = (processes: { id: string }[]) => processes.map((p) => p.id);

export const FEATURES: FeatureDef[] = [
  {
    id: "costing.costs",
    label: "feature.costing.costs",
    processes: [...ids(COST_PROCESSES), ...ids(VOID_PROCESSES), ...ids(CONSULT_PROCESSES)],
    entities: ["costing.cost_layer", "costing.cost_event", "costing.cost_missing"],
    nav: nav("costing.costs"),
  },
  {
    id: "costing.landed_costs",
    label: "feature.costing.landed_costs",
    processes: ids(LANDED_COST_PROCESSES),
    entities: ["costing.landed_cost", "costing.landed_cost_line"],
    nav: nav("costing.landed_costs"),
  },
  {
    id: "costing.settings",
    label: "feature.costing.settings",
    processes: ids(SETTINGS_PROCESSES),
    entities: ["costing.settings"],
    nav: nav("costing.settings"),
  },
];
