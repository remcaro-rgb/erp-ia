import type { Sql } from "postgres";
import { recordLlmUsage, type LlmUsageRow } from "@erp/kernel";

// Metering of the assistant's model calls (rule 27, design §7.4): one `kernel.llm_usage` row per model step of a turn,
// with the provider (from the gateway model id), the tokens the step reported, the cache-read tokens when the provider
// gives them, and the cost from the price table.

export { attributeModel, stepUsage } from "./step-usage";
export type { StepTokens } from "./step-usage";

/** Writes one usage row (service connection); a row of the same run, step and task is written once. */
export async function recordUsage(sql: Sql, row: LlmUsageRow): Promise<void> {
  await recordLlmUsage(sql, row);
}
