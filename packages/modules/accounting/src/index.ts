import { defineModule, POSTING_CONSUMER, type ModuleDef } from "@erp/kernel";
import { ACCOUNTING_ENTITIES } from "./entities";
import { FEATURES, NAVIGATION } from "./features";
import { accountingProvider } from "./posting/provider";
import { ACCOUNTING_PROCESSES } from "./processes";
import { ACCOUNTING_DEFAULT_RULES } from "./rules/defaults";

/**
 * The accounting module (accounting design §3): chart of accounts, fuentes, periods, four analytic dimensions, comprobantes,
 * posting rules and the reports over them. It is the posting engine's provider (Task 20 registers `postingProvider`, which the
 * loader wires to the `"*"` consumer below); `recordTabs`, `reports` and `homeKpis` arrive with Tasks 22–29.
 */
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
  postingProvider: accountingProvider,
  postingRules: ACCOUNTING_DEFAULT_RULES,
});

export { ACCOUNTING_ENTITIES } from "./entities";
export { DIMENSIONS, DIMENSION_DEFS } from "./dimensions";
export type { Dimension, DimensionDef } from "./dimensions";
