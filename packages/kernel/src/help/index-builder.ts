import type { Sql } from "postgres";
import { recordLlmUsage, type EmbeddingUsage } from "../ai/usage";
import type { Registry } from "../registry";
import { vectorText, type Embedder } from "./embedder";
import { chunkGuide, loadGuides } from "./guides";
import { processChunks } from "./process-chunks";

export interface BuildHelpIndexOptions {
  /** Folder of the user guides (`docs/user-guide/es-419`). */
  guidesDir: string;
  /** The loaded registry: one chunk per process it holds. */
  registry: Registry;
  /** Locale of the guides; default `es-419`. */
  locale?: string;
}

export interface HelpIndexSummary {
  guides: number;
  guideChunks: number;
  processChunks: number;
}

interface Row {
  source: string;
  href: string | null;
  title: string;
  body: string;
}

/**
 * Rebuilds the platform help index (design §7): the chunks of every guide in `guidesDir` (`source` `guide:<file>`,
 * linking to the first route of its front matter) and one chunk per registered process (`source` `process:<id>`,
 * linking to its screen). `sql` is the service connection (rule 12): the index is a build output that no user writes.
 * Everything is embedded first; then the old platform chunks of the locale are deleted and the new ones inserted in
 * one transaction, so a failed rebuild (an embedder error, a wrong vector size) leaves the previous index in place
 * and a search never sees a half-built one.
 */
export async function buildHelpIndex(sql: Sql, embedder: Embedder, options: BuildHelpIndexOptions): Promise<HelpIndexSummary> {
  const locale = options.locale ?? "es-419";
  const guides = loadGuides(options.guidesDir);
  const rows: Row[] = [];
  for (const guide of guides) {
    for (const chunk of chunkGuide(guide)) {
      rows.push({ source: `guide:${guide.file}`, href: guide.routes[0] ?? null, title: chunk.title, body: chunk.body });
    }
  }
  const guideChunks = rows.length;
  for (const chunk of processChunks(options.registry)) {
    rows.push({ source: chunk.source, href: chunk.href ?? null, title: chunk.title, body: chunk.body });
  }

  // The title leads the embedded text: it carries the topic the body assumes. Every call is metered (rule 27) as
  // platform usage: the index belongs to no company.
  const usages: EmbeddingUsage[] = [];
  const embeddings = await embedder.embed(
    rows.map((row) => `${row.title}\n${row.body}`),
    { onUsage: (usage) => void usages.push(usage) },
  );
  for (const usage of usages) await recordLlmUsage(sql, { companyId: null, task: "embeddings", model: usage.model, inputTokens: usage.tokens });
  if (embeddings.length !== rows.length) throw new Error(`embedder returned ${embeddings.length} vectors for ${rows.length} texts`);

  await sql.begin(async (tx) => {
    await tx`delete from kernel.help_chunks where scope = 'platform' and locale = ${locale}`;
    if (rows.length === 0) return;
    await tx`
      insert into kernel.help_chunks (scope, source, href, title, body, embedding, locale)
      select 'platform', r.source, r.href, r.title, r.body, r.embedding::extensions.vector, ${locale}
      from unnest(
        ${rows.map((r) => r.source)}::text[],
        ${rows.map((r) => r.href)}::text[],
        ${rows.map((r) => r.title)}::text[],
        ${rows.map((r) => r.body)}::text[],
        ${embeddings.map(vectorText)}::text[]
      ) as r(source, href, title, body, embedding)`;
  });
  return { guides: guides.length, guideChunks, processChunks: rows.length - guideChunks };
}
