import { z } from "zod";
import { recordLlmUsage } from "../ai/usage";
import { defineProcess } from "../process/define";
import { DEFAULT_RESULTS, helpEmbedder, MAX_RESULTS, searchHelp } from "./search";

const FEATURE = "kernel.help";

/** The query's embedding call runs inside the process transaction: it is aborted after this long (Task 16 review). */
export const HELP_EMBED_TIMEOUT_MS = 8_000;

/**
 * `kernel.help.search` (design §7): the assistant's and the help box's way to answer "how do I…". A consult over the
 * knowledge index (user guides and the process registry), behind the role matrix like any consult.
 */
export const helpSearch = defineProcess({
  id: "kernel.help.search",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Busca en la ayuda (guías de usuario y procesos) cómo hacer algo y devuelve los pasos y la pantalla donde hacerlo",
  input: z.object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
  }),
  output: z.object({
    results: z.array(z.object({ title: z.string(), snippet: z.string(), source: z.string(), href: z.string().optional() })),
  }),
  handler: async (ctx, input) => ({
    results: await searchHelp(ctx.tx, helpEmbedder(), {
      query: input.query,
      limit: input.limit,
      companyId: ctx.companyId,
      locale: ctx.locale,
      embed: {
        signal: AbortSignal.timeout(HELP_EMBED_TIMEOUT_MS),
        // Metered in the process transaction, as the caller (rule 27; the row policy admits it inside a process run).
        onUsage: (usage) =>
          recordLlmUsage(ctx.tx, {
            companyId: ctx.companyId,
            userId: ctx.userId,
            conversationId: ctx.conversationId ?? null,
            task: "embeddings",
            model: usage.model,
            inputTokens: usage.tokens,
          }),
      },
    }),
  }),
});

export const HELP_PROCESSES = [helpSearch];
