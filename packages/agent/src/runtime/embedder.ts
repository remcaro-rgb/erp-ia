import type { Sql } from "postgres";
import { GatewayEmbedder, type EmbedOptions, type Embedder } from "@erp/kernel";
import { resolveModel } from "./model-policy";

// The help search's embedder (design §7.4, rule 26): the AI Gateway, with the model the policy table names for
// `embeddings`. The platform row decides (tenant null): the help index is shared by every tenant and a query must be
// embedded with the model that built it.

/** How long a resolved model id is reused before the policy table is read again. */
const POLICY_TTL_MS = 60_000;

export class PolicyEmbedder implements Embedder {
  private cached: { modelId: string; at: number } | undefined;

  constructor(private readonly sql: Sql) {}

  /** The policy's primary embeddings model, read at most once a minute. */
  async modelId(): Promise<string> {
    if (!this.cached || Date.now() - this.cached.at > POLICY_TTL_MS) {
      this.cached = { modelId: (await resolveModel(this.sql, null, "embeddings")).primary, at: Date.now() };
    }
    return this.cached.modelId;
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    return new GatewayEmbedder(await this.modelId()).embed(texts, options);
  }
}
