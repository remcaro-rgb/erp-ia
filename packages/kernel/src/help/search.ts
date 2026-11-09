import type { Tx } from "../db/client";
import { GatewayEmbedder, vectorText, type EmbedOptions, type Embedder } from "./embedder";

// Searching the help index (design §7): the question is embedded and the nearest chunks by cosine distance come back
// with a short snippet and the screen to open.

// Kept on globalThis, like the file store: the workflow step bundle loads this module a second time and must see
// the embedder the app installed.
const GLOBAL_KEY = Symbol.for("erp.kernel.helpEmbedder");
const globals = globalThis as { [GLOBAL_KEY]?: Embedder };

/** Installs the embedder `kernel.help.search` uses; `undefined` goes back to the gateway default. */
export function setHelpEmbedder(embedder: Embedder | undefined): void {
  globals[GLOBAL_KEY] = embedder;
}

/**
 * The installed embedder, or the AI Gateway's default embeddings model. The web app installs one that reads the model
 * from `kernel.model_policies` (task `embeddings`, the platform row the index was built with).
 */
export function helpEmbedder(): Embedder {
  return (globals[GLOBAL_KEY] ??= new GatewayEmbedder());
}

/** The embedder an app installed with `setHelpEmbedder`, if any (the default is not installed until first use). */
export function installedHelpEmbedder(): Embedder | undefined {
  return globals[GLOBAL_KEY];
}

export const MAX_RESULTS = 10;
export const DEFAULT_RESULTS = 5;
export const SNIPPET_CHARS = 300;
/** The locale searched when the caller's own has no index yet. */
const DEFAULT_FALLBACK_LOCALE = "es-419";

/** One line of plain text, at most `SNIPPET_CHARS` long and cut at a word, with `…` when something was dropped. */
export function snippetOf(text: string): string {
  const plain = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= SNIPPET_CHARS) return plain;
  const cut = plain.slice(0, SNIPPET_CHARS - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > SNIPPET_CHARS / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

export interface HelpResult {
  title: string;
  snippet: string;
  source: string;
  href?: string;
}

export interface SearchHelpOptions {
  query: string;
  limit: number;
  /** The active company: its own chunks are searched along with the platform's. */
  companyId: string;
  locale: string;
  /** The locale searched when `locale` has no platform index; default `es-419`. */
  fallbackLocale?: string;
  /** How the query's embedding call is aborted and metered. */
  embed?: EmbedOptions;
}

/** The embedding of a search query, alone (outside any transaction when the caller wants it so). */
export async function embedQuery(embedder: Embedder, query: string, options: EmbedOptions = {}): Promise<number[]> {
  const [embedding] = await embedder.embed([query], options);
  if (!embedding) throw new Error("embedder returned no vector for the query");
  return embedding;
}

/** The nearest chunks to `query`, as the caller (RLS applies) in `tx`: platform chunks and the active company's. */
export async function searchHelp(tx: Tx, embedder: Embedder, options: SearchHelpOptions): Promise<HelpResult[]> {
  return searchHelpByEmbedding(tx, await embedQuery(embedder, options.query, options.embed), options);
}

/**
 * The nearest chunks to an embedding already computed (`embedQuery`), as the caller in `tx`. The assistant embeds the
 * user's text before it opens the transaction, so a slow model call never holds one open.
 */
export async function searchHelpByEmbedding(tx: Tx, embedding: number[], options: Omit<SearchHelpOptions, "query" | "embed">): Promise<HelpResult[]> {
  const vector = vectorText(embedding);
  // The locale / scope filter runs after an HNSW scan, which only hands over ~hnsw.ef_search candidates: rows of other
  // locales (or dead index entries) leave fewer than `limit` results, or none (CI docker-integration, 2026-11-09). The
  // help index is a few thousand rows at most, so the search is exact: index scans are off for this transaction.
  await tx`select set_config('enable_indexscan', 'off', true)`;
  const rows = await tx<{ title: string; body: string; source: string; href: string | null }[]>`
    select title, body, source, href
    from kernel.help_chunks
    where locale = case when exists (select 1 from kernel.help_chunks where scope = 'platform' and locale = ${options.locale}) then ${options.locale} else ${options.fallbackLocale ?? DEFAULT_FALLBACK_LOCALE} end
      and (scope = 'platform' or company_id = ${options.companyId})
    order by embedding operator(extensions.<=>) ${vector}::extensions.vector
    limit ${Math.min(options.limit, MAX_RESULTS)}`;
  return rows.map((row) => ({ title: row.title, snippet: snippetOf(row.body), source: row.source, ...(row.href ? { href: row.href } : {}) }));
}
