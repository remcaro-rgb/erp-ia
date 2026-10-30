import type { ProcessDef } from "@erp/kernel";
import { ACCOUNT_PROCESSES } from "./account";
import { CHART_PROCESSES } from "./chart";
import { DIMENSION_PROCESSES } from "./dimension";
import { CONCEPT_MAPPING_PROCESSES } from "./concept-mapping";
import { FISCAL_YEAR_PROCESSES } from "./fiscal-year";
import { JOURNAL_PROCESSES } from "./journal";
import { MAPPING_PROCESSES } from "./mapping";
import { PERMISSION_PROCESSES } from "./permission";
import { SETTINGS_PROCESSES } from "./settings";

/** Every process of the module; the tasks of Part C onward append their arrays here. */
export const ACCOUNTING_PROCESSES: ProcessDef[] = [
  ...CHART_PROCESSES,
  ...ACCOUNT_PROCESSES,
  ...JOURNAL_PROCESSES,
  ...DIMENSION_PROCESSES,
  ...FISCAL_YEAR_PROCESSES,
  ...SETTINGS_PROCESSES,
  ...MAPPING_PROCESSES,
  ...PERMISSION_PROCESSES,
  ...CONCEPT_MAPPING_PROCESSES,
];
