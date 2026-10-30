import type { FeatureDef, NavItem } from "@erp/kernel";
import { ACCOUNTING_PROCESSES } from "./processes";

// Features of the accounting module (design §6) and the menu items they unlock. Labels are i18n keys. The bar shows six
// items in this order; the masters sit under the Maestros group (design §8, §10b.19). The three optional analytic masters
// are hidden by the shell while their `use_*` setting is off (Task 26).

export const NAVIGATION: NavItem[] = [
  { id: "accounting.entries", label: "nav.accounting.entries", href: "/accounting/entries", icon: "book-open", feature: "accounting.ledger" },
  { id: "accounting.movements", label: "nav.accounting.movements", href: "/accounting/movements", icon: "list-tree", feature: "accounting.ledger" },
  {
    id: "accounting.masters",
    label: "nav.accounting.masters",
    href: "#",
    icon: "folder-tree",
    children: [
      { id: "accounting.accounts", label: "nav.accounting.accounts", href: "/accounting/accounts", icon: "list-tree", feature: "accounting.ledger" },
      { id: "accounting.cost_centers", label: "nav.accounting.cost_centers", href: "/accounting/cost-centers", icon: "network", feature: "accounting.ledger" },
      { id: "accounting.open_auxiliaries", label: "nav.accounting.open_auxiliaries", href: "/accounting/open-auxiliaries", icon: "network", feature: "accounting.ledger" },
      { id: "accounting.items", label: "nav.accounting.items", href: "/accounting/items", icon: "network", feature: "accounting.ledger" },
      { id: "accounting.business_units", label: "nav.accounting.business_units", href: "/accounting/business-units", icon: "network", feature: "accounting.ledger" },
      { id: "accounting.journals", label: "nav.accounting.journals", href: "/accounting/journals", icon: "notebook", feature: "accounting.ledger" },
    ],
  },
  { id: "accounting.periods", label: "nav.accounting.periods", href: "/accounting/periods", icon: "calendar-days", feature: "accounting.periods" },
  { id: "accounting.reports", label: "nav.accounting.reports", href: "/accounting/reports", icon: "file-bar-chart", feature: "accounting.ledger" },
  { id: "accounting.posting", label: "nav.accounting.posting", href: "/accounting/posting", icon: "workflow", feature: "accounting.posting" },
];

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
