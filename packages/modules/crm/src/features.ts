import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { ACTIVITY_PROCESSES } from "./processes/activity";
import { LEAD_PROCESSES } from "./processes/lead";
import { OPPORTUNITY_PROCESSES } from "./processes/opportunity";
import { PIPELINE_PROCESSES } from "./processes/pipeline";
import { QUOTE_PROCESSES } from "./processes/quote";
import { SETTINGS_PROCESSES } from "./processes/settings";

// Features of the crm module (design §5.12, §8) and its menu. Labels are i18n keys. The level-1 items are the four sections (entity types
// spec §2.4, §9.2): Prospectos and Embudos under Maestros; Oportunidades and Cotizaciones (Task 12) under Documentos; Actividades under
// Reportes; Parámetros de CRM (the approval threshold and validity of the cotizaciones) under Parámetros. The addresses are
// the pages of Task 14b. Every process sits under the item of its
// entity, so hiding an item refuses its processes; nothing is shared.

/** Processes no menu item guards (ModuleDef.menuShared): none. */
export const MENU_SHARED: string[] = [];

export const NAVIGATION: NavItem[] = menuSections("crm", {
  maestros: [
    { id: "crm.leads", label: "nav.crm.leads", href: "/crm/leads", icon: "users", feature: "crm.leads", entity: "crm.lead" },
    { id: "crm.pipelines", label: "nav.crm.pipelines", href: "/crm/pipelines", icon: "workflow", feature: "crm.pipelines", entity: "crm.pipeline" },
  ],
  documentos: [
    { id: "crm.opportunities", label: "nav.crm.opportunities", href: "/crm/opportunities", icon: "file-text", feature: "crm.opportunities", entity: "crm.opportunity" },
    { id: "crm.quotes", label: "nav.crm.quotes", href: "/crm/quotes", icon: "file-text", feature: "crm.quotes", entity: "crm.quote" },
  ],
  reportes: [
    { id: "crm.activities", label: "nav.crm.activities", href: "/crm/activities", icon: "calendar-days", feature: "crm.activities", entity: "crm.activity" },
  ],
  parametros: [
    { id: "crm.settings", label: "nav.crm.settings", href: "/crm/settings", icon: "sliders", feature: "crm.settings", entity: "crm.settings" },
  ],
});

/** Items of the bar whose gate is `feature`. */
const nav = (feature: string) => NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

const ids = (processes: { id: string }[]) => processes.map((p) => p.id);

export const FEATURES: FeatureDef[] = [
  { id: "crm.leads", label: "feature.crm.leads", processes: ids(LEAD_PROCESSES), entities: ["crm.lead"], nav: nav("crm.leads") },
  { id: "crm.pipelines", label: "feature.crm.pipelines", processes: ids(PIPELINE_PROCESSES), entities: ["crm.pipeline", "crm.stage"], nav: nav("crm.pipelines") },
  { id: "crm.opportunities", label: "feature.crm.opportunities", processes: ids(OPPORTUNITY_PROCESSES), entities: ["crm.opportunity", "crm.opportunity_line"], nav: nav("crm.opportunities") },
  { id: "crm.activities", label: "feature.crm.activities", processes: ids(ACTIVITY_PROCESSES), entities: ["crm.activity"], nav: nav("crm.activities") },
  { id: "crm.quotes", label: "feature.crm.quotes", processes: ids(QUOTE_PROCESSES), entities: ["crm.quote", "crm.quote_line"], nav: nav("crm.quotes") },
  { id: "crm.settings", label: "feature.crm.settings", processes: ids(SETTINGS_PROCESSES), entities: ["crm.settings"], nav: nav("crm.settings") },
];
