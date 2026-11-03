import type { ProcessDef } from "@erp/kernel";
import { REPORT_PROCESSES } from "../reports";
import { ACCOUNT_PROCESSES } from "./account";
import { CHART_PROCESSES } from "./chart";
import { DIMENSION_PROCESSES } from "./dimension";
import { ENTRY_PROCESSES } from "./entry";
import { EXOGENA_XML_PROCESSES } from "./exogena-xml";
import { ENTRY_POST_PROCESSES } from "./entry-post";
import { ENTRY_LIFECYCLE_PROCESSES } from "./entry-lifecycle";
import { CONCEPT_MAPPING_PROCESSES } from "./concept-mapping";
import { FISCAL_YEAR_PROCESSES } from "./fiscal-year";
import { JOURNAL_PROCESSES } from "./journal";
import { LEDGER_LINE_PROCESSES } from "./ledger-line";
import { MAPPING_PROCESSES } from "./mapping";
import { OPENING_PROCESSES } from "./opening";
import { PERIOD_PROCESSES } from "./period";
import { PERMISSION_PROCESSES } from "./permission";
import { POST_FROM_EVENT_PROCESSES } from "./post-from-event";
import { POSTING_FAILURE_PROCESSES } from "./posting-failure";
import { POSTING_RULE_PROCESSES } from "./posting-rule";
import { SETTINGS_PROCESSES } from "./settings";
import { TEMPLATE_PROCESSES } from "./template";
import { YEAR_PROCESSES } from "./year";

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
  ...ENTRY_PROCESSES,
  ...TEMPLATE_PROCESSES,
  ...ENTRY_POST_PROCESSES,
  ...ENTRY_LIFECYCLE_PROCESSES,
  ...OPENING_PROCESSES,
  ...POST_FROM_EVENT_PROCESSES,
  ...POSTING_RULE_PROCESSES,
  ...POSTING_FAILURE_PROCESSES,
  ...PERIOD_PROCESSES,
  ...YEAR_PROCESSES,
  ...REPORT_PROCESSES,
  ...EXOGENA_XML_PROCESSES,
  ...LEDGER_LINE_PROCESSES,
];
