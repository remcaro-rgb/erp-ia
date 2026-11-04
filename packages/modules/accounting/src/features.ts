import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { ACCOUNTING_PROCESSES } from "./processes";

// Features of the accounting module (design §6) and the menu items they unlock. Labels are i18n keys. The menu's level-1 items are the four
// sections (entity types spec §2.4, design §22.23): the masters under Maestros (design §8, §10b.19), Comprobantes under Documentos,
// Movimientos and Informes under Reportes, Períodos and Reglas contables under Parámetros. The three optional analytic masters are hidden
// by the shell while their `use_*` setting is off (Task 26). Each item names the entity whose screen it is, and `runs` the other processes
// its screen runs: while an item is hidden for a caller (kernel.menu_access) those are refused to them too. MENU_SHARED lists what no single
// screen owns (the settings every screen reads); the module test asserts every other process sits under an item.

/** Processes no menu item guards (ModuleDef.menuShared). */
export const MENU_SHARED = ["accounting.settings.consult"];

export const NAVIGATION: NavItem[] = menuSections("accounting", {
  maestros: [
    { id: "accounting.accounts", label: "nav.accounting.accounts", href: "/accounting/accounts", icon: "list-tree", feature: "accounting.ledger", entity: "accounting.account", runs: ["accounting.account_permission."] },
    { id: "accounting.cost_centers", label: "nav.accounting.cost_centers", href: "/accounting/cost-centers", icon: "network", feature: "accounting.ledger", entity: "accounting.cost_center" },
    { id: "accounting.open_auxiliaries", label: "nav.accounting.open_auxiliaries", href: "/accounting/open-auxiliaries", icon: "split", feature: "accounting.ledger", entity: "accounting.open_auxiliary" },
    { id: "accounting.items", label: "nav.accounting.items", href: "/accounting/items", icon: "boxes", feature: "accounting.ledger", entity: "accounting.item" },
    { id: "accounting.business_units", label: "nav.accounting.business_units", href: "/accounting/business-units", icon: "building", feature: "accounting.ledger", entity: "accounting.business_unit" },
    { id: "accounting.journals", label: "nav.accounting.journals", href: "/accounting/journals", icon: "notebook", feature: "accounting.ledger", entity: "accounting.journal" },
    { id: "accounting.entry_templates", label: "nav.accounting.entry_templates", href: "/accounting/entry-templates", icon: "bookmark", feature: "accounting.ledger", entity: "accounting.entry_template", runs: ["accounting.entry_template."] },
  ],
  documentos: [
    // Comprobantes also creates entries from templates and the opening balance (saldos iniciales), both comprobantes.
    { id: "accounting.entries", label: "nav.accounting.entries", href: "/accounting/entries", icon: "book-open", feature: "accounting.ledger", entity: "accounting.entry", runs: ["accounting.entry_template.", "accounting.opening."] },
  ],
  reportes: [
    { id: "accounting.movements", label: "nav.accounting.movements", href: "/accounting/movements", icon: "list-tree", feature: "accounting.ledger", entity: "accounting.ledger_line" },
    { id: "accounting.reports", label: "nav.accounting.reports", href: "/accounting/reports", icon: "file-bar-chart", feature: "accounting.ledger", runs: ["accounting.report."] },
  ],
  parametros: [
    { id: "accounting.periods", label: "nav.accounting.periods", href: "/accounting/periods", icon: "calendar-days", feature: "accounting.periods", entity: "accounting.period", runs: ["accounting.fiscal_year.", "accounting.year."] },
    {
      id: "accounting.posting",
      label: "nav.accounting.posting",
      href: "/accounting/posting",
      icon: "workflow",
      feature: "accounting.posting",
      entity: "accounting.posting_rule",
      runs: ["accounting.posting.", "accounting.posting_failure.", "accounting.account_role_mapping.", "accounting.fiscal_concept_mapping.", "accounting.settings.update", "accounting.chart.seed"],
    },
  ],
});

const forFeature = (feature: string) => ACCOUNTING_PROCESSES.filter((p) => p.feature === feature).map((p) => p.id);

/** Items of the bar whose gate is `feature`, group children included. */
const nav = (feature: string) =>
  NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

export const FEATURES: FeatureDef[] = [
  {
    id: "accounting.ledger",
    label: "feature.accounting.ledger",
    processes: forFeature("accounting.ledger"),
    entities: [
      "accounting.account", "accounting.account_permission", "accounting.journal", "accounting.cost_center", "accounting.open_auxiliary",
      "accounting.item", "accounting.business_unit", "accounting.entry", "accounting.entry_line", "accounting.entry_template",
      "accounting.entry_template_line", "accounting.ledger_line",
    ],
    nav: nav("accounting.ledger"),
  },
  {
    id: "accounting.periods",
    label: "feature.accounting.periods",
    processes: forFeature("accounting.periods"),
    entities: ["accounting.fiscal_year", "accounting.period", "accounting.period_close_check"],
    nav: nav("accounting.periods"),
  },
  {
    id: "accounting.posting",
    label: "feature.accounting.posting",
    processes: forFeature("accounting.posting"),
    entities: [
      "accounting.posting_rule", "accounting.posting_failure", "accounting.account_role_mapping", "accounting.fiscal_concept_mapping",
      "accounting.settings",
    ],
    nav: nav("accounting.posting"),
  },
];
