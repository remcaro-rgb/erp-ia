import type { Sql } from "postgres";

// Which model serves a task (design §7.4, rule 26): read from kernel.model_policies on every call, so a tenant moves to
// another model or provider without a deploy. No model id lives in code.

/** The tasks the runtime asks a policy for. */
export type AgentTask = "chat" | "planning" | "classification" | "summarization" | "extraction" | "embeddings" | "recommendations";

export interface ModelChoice {
  /** AI Gateway model id (`anthropic/claude-opus-5.5`). */
  primary: string;
  /** Tried in order when the primary fails. */
  fallbacks: string[];
}

/** No policy for the task, not even the platform's: a configuration error, never a silent default model. */
export class MissingModelPolicy extends Error {
  constructor(readonly task: AgentTask) {
    super(`no model policy for task ${task}`);
    this.name = "MissingModelPolicy";
  }
}

/**
 * The model policy for `task`: the tenant's own row when it has one, else the platform row (`tenant_id null`).
 * `tenantId` null asks for the platform row only (the help index, whose vectors every tenant shares). Service connection.
 */
export async function resolveModel(sql: Sql, tenantId: string | null, task: AgentTask): Promise<ModelChoice> {
  const [row] = await sql<{ primary_model: string; fallbacks: string[] }[]>`
    select primary_model, fallbacks from kernel.model_policies
    where task = ${task} and (tenant_id is null or tenant_id = ${tenantId})
    order by tenant_id nulls last
    limit 1`;
  if (!row) throw new MissingModelPolicy(task);
  return { primary: row.primary_model, fallbacks: row.fallbacks };
}

/** The provider segment of a gateway model id (`anthropic/claude-opus-5.5` → `anthropic`). */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "unknown";
}
