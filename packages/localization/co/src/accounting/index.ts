import type { AccountingPack } from "@erp/kernel";
import { validateAccountCode } from "./account-code";
import { chartOfAccounts, extraAccounts } from "./chart";
import { fiscalYearFor } from "./fiscal-year";
import { defaultJournals } from "./journals";
import { statementLayouts } from "./layouts";
import { defaultRoleMappings } from "./role-mappings";
import { taxCodes } from "./tax-codes";

export const accounting: AccountingPack = {
  chartOfAccounts,
  defaultRoleMappings,
  extraAccounts,
  validateAccountCode,
  fiscalYearFor,
  statementLayouts,
  defaultJournals,
  taxCodes,
  // Task 11 fills the exógena catalogue, concept mappings and XML writer.
  defaultConceptMappings: () => [],
  exogenaFormats: () => [],
  exogenaXml: () => {
    throw new Error("exogenaXml is not available yet");
  },
};
