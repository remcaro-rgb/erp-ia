import { embedMany } from "ai";
import type { EmbeddingUsage } from "../ai/usage";

/** Dimensions of the `kernel.help_chunks.embedding` column (migration 0018): `openai/text-embedding-3-small`. */
export const EMBEDDING_DIMENSIONS = 1536;

/** The embeddings model of the design's defaults (rule 26); Task 17 resolves it from `kernel.model_policies` instead. */
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** The pgvector text form of an embedding (`[0.1,0.2,…]`), to cast with `::extensions.vector`. */
export const vectorText = (embedding: number[]): string => `[${embedding.join(",")}]`;

/** How one embedding call is run and metered. */
export interface EmbedOptions {
  /** Aborts the call (a timeout, so a slow provider never holds a database transaction open). */
  signal?: AbortSignal;
  /** Receives the call's model and token count once it answered (rule 27: every call is metered). */
  onUsage?: (usage: EmbeddingUsage) => void | Promise<void>;
}

/** Turns texts into vectors of `EMBEDDING_DIMENSIONS`, one per text and in the same order. */
export interface Embedder {
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
}

/**
 * Embeds through the AI SDK and the Vercel AI Gateway (rule 26: models only through the AI SDK). The gateway model
 * id is a constructor argument; the caller reads it from the model policy table (`task = 'embeddings'`).
 */
export class GatewayEmbedder implements Embedder {
  constructor(readonly modelId: string = DEFAULT_EMBEDDING_MODEL) {}

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    // A string model id resolves through the gateway (AI_GATEWAY_API_KEY, or OIDC on Vercel); embedMany splits
    // the values into as many calls as the model allows and sums their usage.
    const { embeddings, usage } = await embedMany({ model: this.modelId, values: texts, abortSignal: options.signal });
    await options.onUsage?.({ model: this.modelId, tokens: usage.tokens });
    return embeddings;
  }
}

const STOPWORDS = new Set(["como", "para", "los", "las", "una", "uno", "con", "del", "por", "que", "sus", "tus", "mis", "esta", "este", "son", "hay", "puedo"]);
/** Words are compared by their first characters, so "exporto", "exportar" and "exportación" meet. */
const STEM_LENGTH = 4;

function words(text: string): string[] {
  const plain = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return (plain.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** FNV-1a, 32 bits. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * Deterministic embeddings for tests and for an index built without a gateway key: each word and its stem is hashed
 * into one of the 1536 dimensions (a signed bag of words), then the vector is scaled to unit length. Texts that
 * share words are close in cosine distance; it knows nothing about meaning, so it never ships to a real search.
 */
export class FakeEmbedder implements Embedder {
  /** The model id its usage is metered under; priced at zero. */
  static readonly MODEL = "fake/hash-embedder";

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    options.signal?.throwIfAborted();
    // One token per indexable word (at least one per text), so metering is exercised like a real call.
    await options.onUsage?.({ model: FakeEmbedder.MODEL, tokens: texts.reduce((sum, text) => sum + Math.max(1, words(text).length), 0) });
    return texts.map((text) => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of words(text)) {
        for (const feature of new Set([word, `~${word.slice(0, STEM_LENGTH)}`])) {
          const h = hash(feature);
          vector[h % EMBEDDING_DIMENSIONS]! += (h >>> 16) & 1 ? 1 : -1;
        }
      }
      // A text with no indexable word (empty, punctuation, stopwords) would be all zeros and its cosine NaN: it
      // lands in one fixed bucket instead.
      if (!vector.some(Boolean)) vector[0] = 1;
      const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
      return vector.map((x) => x / norm);
    });
  }
}
