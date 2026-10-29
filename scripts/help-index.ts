/**
 * Rebuilds the platform help index: `pnpm help:index` (design §7, rule 35).
 *
 *  1. Loads the modules the web app loads (apps/web/src/lib/server/runtime.ts) into a registry.
 *  2. Checks the guides in docs/user-guide/es-419 against it (screens and processes they name exist, every menu
 *     screen has a guide) and stops on a problem.
 *  3. Embeds the guide chunks and one chunk per registered process and replaces the platform rows of
 *     `kernel.help_chunks` in one transaction. It writes with the service role through `DATABASE_URL` (the local
 *     Supabase database when unset).
 *
 * Embeddings go through the AI Gateway when `AI_GATEWAY_API_KEY` is set, with the model `kernel.model_policies` names
 * for `embeddings` (rule 26; the code default only when the table has no such row, with a warning); without a key the
 * deterministic `FakeEmbedder` is used and the script says so (fine for a local stack, not for a search people rely
 * on). Every embedding call is metered as platform usage (`kernel.llm_usage`).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { MissingModelPolicy, resolveModel, type ModelChoice } from "@erp/agent";
import {
  buildHelpIndex,
  DEFAULT_EMBEDDING_MODEL,
  FakeEmbedder,
  GatewayEmbedder,
  getServiceDb,
  guideProblems,
  kernelModule,
  loadGuides,
  loadModules,
  Registry,
  type Embedder,
} from "@erp/kernel";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
export const GUIDES_DIR = join(ROOT, "docs", "user-guide", "es-419");

/** A registry with the modules apps/web loads, in the same order. */
export function loadAppRegistry(): Registry {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, support]);
  return registry;
}

/**
 * The embeddings model of the policy table (the platform row: the index is shared by every tenant). Only when the
 * table has no row for the task does it fall back to the code default, and it warns.
 */
export async function policyEmbeddingModel(resolve: () => Promise<ModelChoice>, warn: (message: string) => void): Promise<string> {
  try {
    return (await resolve()).primary;
  } catch (error) {
    if (!(error instanceof MissingModelPolicy)) throw error;
    warn(`help:index: no model policy for embeddings, using the default ${DEFAULT_EMBEDDING_MODEL}`);
    return DEFAULT_EMBEDDING_MODEL;
  }
}

/** The gateway embedder (with `modelId`) when `AI_GATEWAY_API_KEY` is set, else the fake one; `name` says which, for the log. */
export function pickEmbedder(env: Record<string, string | undefined>, modelId: string = DEFAULT_EMBEDDING_MODEL): { embedder: Embedder; name: string } {
  if (env.AI_GATEWAY_API_KEY) return { embedder: new GatewayEmbedder(modelId), name: `GatewayEmbedder (${modelId})` };
  return { embedder: new FakeEmbedder(), name: "FakeEmbedder (no AI_GATEWAY_API_KEY: deterministic hash vectors, not semantic)" };
}

async function main(): Promise<void> {
  const registry = loadAppRegistry();
  const problems = guideProblems(loadGuides(GUIDES_DIR), registry);
  if (problems.length > 0) {
    console.error(`help:index stopped, the guides have problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  const sql = getServiceDb();
  try {
    const modelId = process.env.AI_GATEWAY_API_KEY ? await policyEmbeddingModel(() => resolveModel(sql, null, "embeddings"), console.warn) : undefined;
    const { embedder, name } = pickEmbedder(process.env, modelId);
    console.log(`help:index embedder: ${name}`);
    const summary = await buildHelpIndex(sql, embedder, { guidesDir: GUIDES_DIR, registry });
    console.log(`help:index done: ${summary.guides} guides, ${summary.guideChunks} guide chunks, ${summary.processChunks} process chunks`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import("./env");
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
