import { defineModule, POSTING_CONSUMER, type ModuleDef, type RecordTabContribution } from "@erp/kernel";
import { ACCOUNTING_ENTITIES } from "./entities";
import { FEATURES, NAVIGATION } from "./features";
import { HOME_KPIS } from "./home";
import { accountingProvider } from "./posting/provider";
import { ACCOUNTING_PROCESSES } from "./processes";
import { ACCOUNTING_REPORTS } from "./reports";
import { ACCOUNTING_DEFAULT_RULES } from "./rules/defaults";

/**
 * The accounting module (accounting design §3): chart of accounts, fuentes, periods, four analytic dimensions, comprobantes,
 * posting rules and the reports over them. It is the posting engine's provider (Task 20 registers `postingProvider`, which the
 * loader wires to the `"*"` consumer below); its reports (Tasks 22–24), its home cards (Task 29) and the tabs it adds to other
 * modules' records (Task 29) come with the manifest.
 */
/**
 * Tabs the module adds to other records (accounting design §8, kernel `recordTabs`):
 *  - Contabilidad on every record: the comprobantes whose `source_record_id` is the record (the grid reads `accounting.entry`, whose
 *    view carries `source_entity` and `source_record_id`, so the account security and the field masks apply);
 *  - the revenue account of a product category (`category:{id}`), saved under step-up through the role mappings;
 *  - Cuentas on a role or a user: the accounts the subject may view and post in (rendered by the admin screens, which hold their own
 *    role and user pickers rather than a record page).
 */
export const ACCOUNTING_RECORD_TABS: RecordTabContribution[] = [
  { id: "accounting.entries", label: "common.record.tabs.contabilidad", forEntities: "*", kind: "grid", feature: "accounting.ledger", source: "accounting.entry" },
  {
    id: "accounting.category_revenue",
    label: "common.record.tabs.contabilidad",
    forEntities: ["core.product_category"],
    kind: "mapping",
    feature: "accounting.posting",
    dimension: "category:{id}",
    roles: ["revenue"],
    lookupEntity: "accounting.account",
    saveProcess: "accounting.account_role_mapping.update",
    consultProcess: "accounting.account_role_mapping.consult",
  },
  { id: "accounting.subject_accounts", label: "common.record.tabs.cuentas", forEntities: ["kernel.role", "kernel.user"], kind: "grid", feature: "accounting.ledger", source: "accounting.account_permission" },
];

export const accounting: ModuleDef = defineModule({
  id: "accounting",
  version: "0.1.0",
  dependsOn: ["core"],
  entities: ACCOUNTING_ENTITIES,
  processes: ACCOUNTING_PROCESSES,
  features: FEATURES,
  events: {
    emits: [
      "accounting.entry.submitted", "accounting.entry.posted", "accounting.entry.reversed", "accounting.period.closed",
      "accounting.period.reopened", "accounting.year.closed", "accounting.posting.failed",
    ],
    consumes: { "*": POSTING_CONSUMER },
  },
  navigation: NAVIGATION,
  reports: ACCOUNTING_REPORTS,
  homeKpis: HOME_KPIS,
  recordTabs: ACCOUNTING_RECORD_TABS,
  postingProvider: accountingProvider,
  postingRules: ACCOUNTING_DEFAULT_RULES,
});

export { ACCOUNTING_ENTITIES } from "./entities";
export { DIMENSIONS, DIMENSION_DEFS } from "./dimensions";
export type { Dimension, DimensionDef } from "./dimensions";
export { figureOf, MASTER_ENTITIES, masterTree } from "./masters/tree";
export type { MasterEntity, MasterFigure, MasterTree, MasterTreeItem } from "./masters/tree";
export { accountBalances, listPeriods, listYears, nodeFigures, yearPreview } from "./masters/figures";
export type { AccountBalanceRow, AccountBalances, NodeAccountRow, NodeFigures, PeriodRef, PeriodSummary, YearPreview, YearSummary } from "./masters/figures";
export { HOME_KPIS } from "./home";
