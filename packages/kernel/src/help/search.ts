import type { Tx } from "../db/client";
import { GatewayEmbedder, vectorText, type Embedder } from "./embedder";

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

/** The installed embedder, or the AI Gateway's default embeddings model (task 17 resolves the model from the policy table). */
export function helpEmbedder(): Embedder {
  return (globals[GLOBAL_KEY] ??= new GatewayEmbedder());
}

export const MAX_RESULTS = 10;
export const DEFAULT_RESULTS = 5;
export const SNIPPET_CHARS = 300;
/** The locale searched when the caller's own has no index yet. */
const FALLBACK_LOCALE = "es-419";

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
}

/** The nearest chunks to `query`, as the caller (RLS applies) in `tx`: platform chunks and the active company's. */
export async function searchHelp(tx: Tx, embedder: Embedder, options: SearchHelpOptions): Promise<HelpResult[]> {
  const [embedding] = await embedder.embed([options.query]);
  if (!embedding) throw new Error("embedder returned no vector for the query");
  const vector = vectorText(embedding);
  const rows = await tx<{ title: string; body: string; source: string; href: string | null }[]>`
    select title, body, source, href
    from kernel.help_chunks
    where locale = case when exists (select 1 from kernel.help_chunks where locale = ${options.locale}) then ${options.locale} else ${FALLBACK_LOCALE} end
      and (scope = 'platform' or company_id = ${options.companyId})
    order by embedding operator(extensions.<=>) ${vector}::extensions.vector
    limit ${Math.min(options.limit, MAX_RESULTS)}`;
  return rows.map((row) => ({ title: row.title, snippet: snippetOf(row.body), source: row.source, ...(row.href ? { href: row.href } : {}) }));
}
