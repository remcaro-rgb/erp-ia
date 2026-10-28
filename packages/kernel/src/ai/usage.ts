import type { Sql } from "postgres";
import type { Tx } from "../db/client";

// Metering of every model and embedding call (rule 27, design §7.4): one `kernel.llm_usage` row per call with its
// tokens and its cost in USD, priced at write time from the table below. The agent's turns, the help search and the
// help index build all record through `recordLlmUsage`.

/** USD per million tokens. `cachedInput` prices input tokens read from the provider's prompt cache. */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput: number;
}

/**
 * Prices by AI Gateway model id, from the design's unit prices (§20.1, Claude API price list of 2026-10-06) and the
 * providers' list prices for embeddings. Update together with `kernel.model_policies` when a policy names a new model.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "anthropic/claude-opus-5.5": { input: 4, output: 20, cachedInput: 0.2 },
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10, cachedInput: 0.2 },
  "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "openai/text-embedding-3-small": { input: 0.02, output: 0, cachedInput: 0.02 },
  "openai/text-embedding-ada-002": { input: 0.1, output: 0, cachedInput: 0.1 },
};

/**
 * The price of a model the table does not list: the most expensive chat model's, so an unknown model is never metered
 * below its cost. Test doubles (`fake/…`, `mock/…`) cost nothing.
 */
export const DEFAULT_PRICE: ModelPrice = { input: 4, output: 20, cachedInput: 0.2 };
const FREE: ModelPrice = { input: 0, output: 0, cachedInput: 0 };

export function priceOf(model: string): ModelPrice {
  if (model.startsWith("fake/") || model.startsWith("mock/")) return FREE;
  return MODEL_PRICES[model] ?? DEFAULT_PRICE;
}

/** The cost in USD of one call; `cachedTokens` are part of `inputTokens`. Rounded to the column's 6 decimals. */
export function costUsd(model: string, tokens: { inputTokens: number; outputTokens: number; cachedTokens?: number }): number {
  const price = priceOf(model);
  const cached = Math.min(tokens.cachedTokens ?? 0, tokens.inputTokens);
  const usd = ((tokens.inputTokens - cached) * price.input + cached * price.cachedInput + tokens.outputTokens * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** What an embedder reports for one call. */
export interface EmbeddingUsage {
  model: string;
  tokens: number;
}

export type LlmTask = "chat" | "planning" | "classification" | "summarization" | "extraction" | "embeddings" | "recommendations";

export interface LlmUsageRow {
  /** Null for platform work that belongs to no company (building the help index). */
  companyId: string | null;
  userId?: string | null;
  conversationId?: string | null;
  task: LlmTask;
  /** AI Gateway model id; the provider is its first segment. */
  model: string;
  inputTokens: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** The workflow run and model step that made the call: recorded once however often the step is retried. */
  runId?: string;
  stepNumber?: number;
}

/** The provider segment of a gateway model id (`anthropic/claude-opus-5.5` → `anthropic`). */
export const providerOfModel = (model: string): string => (model.indexOf("/") > 0 ? model.slice(0, model.indexOf("/")) : "unknown");

/**
 * Writes one usage row. `db` is the service connection (agent workflow, index build) or a process transaction as the
 * caller (kernel.help.search: the row policy accepts the caller's own row inside a process run). A row keyed by run
 * and step that is already there is left alone.
 */
export async function recordLlmUsage(db: Sql | Tx, row: LlmUsageRow): Promise<void> {
  const inputTokens = Math.max(0, Math.round(row.inputTokens));
  const outputTokens = Math.max(0, Math.round(row.outputTokens ?? 0));
  const cachedTokens = Math.max(0, Math.round(row.cachedTokens ?? 0));
  const cost = costUsd(row.model, { inputTokens, outputTokens, cachedTokens });
  await db`
    insert into kernel.llm_usage (scope, company_id, user_id, conversation_id, task, provider, model,
                                  input_tokens, output_tokens, cached_tokens, cost_usd, run_id, step_number)
    values (${row.companyId === null ? "platform" : "company"}, ${row.companyId}, ${row.userId ?? null}, ${row.conversationId ?? null},
            ${row.task}, ${providerOfModel(row.model)}, ${row.model}, ${inputTokens}, ${outputTokens}, ${cachedTokens}, ${cost},
            ${row.runId ?? null}, ${row.stepNumber ?? null})
    on conflict do nothing`;
}
