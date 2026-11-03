import { ProcessError } from "../process/errors";
import type { EventConsumer } from "../registry/types";
import { composeEntry, type ComposedEntry, type ComposedLine, type EventRef } from "./compose";
import { resolvePath } from "./path";
import type { PostingFailure, PostingFailureCode, PostingProvider } from "./provider";

/**
 * Placed under `consumes["*"]` in a manifest with a `postingProvider`: the loader swaps it for `postingConsumer(provider)`,
 * so the manifest does not import the engine and the engine never learns the module (rule 4).
 */
export const POSTING_CONSUMER: EventConsumer = async () => {
  throw new Error("POSTING_CONSUMER is replaced by the loader and must not be called directly");
};

const FAILURE_CODES: readonly PostingFailureCode[] = [
  "unbalanced", "missing_account_mapping", "closed_period", "inactive_account", "missing_party", "missing_cost_center",
  "missing_open_auxiliary", "missing_item", "missing_business_unit", "inactive_dimension", "invalid_template", "no_journal",
];

/** The failure code a ledger refusal carries: a code in its details or leading its message, else an invalid template. */
function failureCodeOf(error: ProcessError): PostingFailureCode {
  const candidates = [...(Array.isArray(error.details) ? error.details : []), error.message.split(":")[0]];
  return FAILURE_CODES.find((code) => candidates.includes(code)) ?? "invalid_template";
}

const dateOf = (payload: unknown, createdAt: Date): string => {
  const own = payload !== null && typeof payload === "object" ? (payload as { date?: unknown }).date : undefined;
  return typeof own === "string" && /^\d{4}-\d{2}-\d{2}/.test(own) ? own.slice(0, 10) : createdAt.toISOString().slice(0, 10);
};

/**
 * The engine (design §5.1, §5.5): per event, every active rule in priority order is composed, its roles resolved through
 * the provider and posted. A configuration or state problem (template, mapping, a ledger refusal) is recorded as a
 * posting failure and the next rule runs; anything else, such as a lost connection, propagates so the outbox retries.
 */
export function postingConsumer(provider: PostingProvider): EventConsumer {
  return async (ctx, payload) => {
    // The provider's own lifecycle events (a document the lifecycle is posting itself) never reach a rule: no double posting.
    if (provider.ignores?.(ctx.event.name)) return;
    // A record entering a status (`<entity>.status_changed`, the typed lifecycle's notice for the state e-mails, Task 12) is not a
    // business event: what posts is the action itself (Contabiliza, `<entity>.ready_to_post`). It is neither posted nor counted as skipped.
    if (ctx.event.name.endsWith(".status_changed")) return;
    const event: EventRef = { id: ctx.event.id, event: ctx.event.name, payload, createdAt: ctx.event.createdAt, chainId: ctx.chainId };
    const eventDate = dateOf(payload, event.createdAt);
    const starts = await provider.ledgerStartsOn(ctx);
    if (starts === null || eventDate < starts.toISOString().slice(0, 10)) {
      await provider.countSkipped(ctx, event.id);
      return;
    }
    const settings = await provider.composeSettings(ctx);
    const rules = [...(await provider.rulesFor(ctx, event.event))].sort((a, b) => a.priority - b.priority);
    for (const rule of rules) {
      const fail = (code: PostingFailureCode, detail: string): Promise<void> =>
        provider.recordFailure(ctx, { eventId: event.id, event: event.event, eventDate, ruleId: rule.id, payload, code, detail } satisfies PostingFailure);

      if (rule.template.reverseOf) {
        const ref = rule.template.reverseOf;
        // Nothing posted for the referenced source (it predates the ledger, or had no rule): nothing to reverse.
        await provider.reverse(ctx, { event: ref.event, sourceId: String(resolvePath(payload, ref.sourceId) ?? "") });
        continue;
      }
      const composed = composeEntry(rule.template, event, settings);
      if (!composed.ok) {
        await fail(composed.code, composed.detail);
        continue;
      }
      const resolved = await resolveRoles(provider, ctx, composed.entry);
      if (!resolved.ok) {
        await fail("missing_account_mapping", resolved.detail);
        continue;
      }
      try {
        await provider.post(ctx, resolved.entry, rule);
      } catch (error) {
        if (!(error instanceof ProcessError)) throw error;
        await fail(failureCodeOf(error), error.message);
      }
    }
  };
}

type Resolved = { ok: true; entry: ComposedEntry } | { ok: false; detail: string };

/** Explicit account kept; else (role, dimension), then (role, none) (design §4.2). */
async function resolveRoles(provider: PostingProvider, ctx: Parameters<EventConsumer>[0], entry: ComposedEntry): Promise<Resolved> {
  const resolve = async (line: ComposedLine): Promise<ComposedLine | string> => {
    if (line.accountCode || !line.role) return line;
    const account = (line.dimension ? await provider.resolveAccount(ctx, line.role, line.dimension) : null) ?? (await provider.resolveAccount(ctx, line.role));
    return account ? { ...line, accountCode: account.code } : `${line.role}${line.dimension ? `:${line.dimension}` : ""}`;
  };
  const lines: ComposedLine[] = [];
  for (const line of entry.lines) {
    const out = await resolve(line);
    if (typeof out === "string") return { ok: false, detail: `Sin cuenta para el rol ${out}` };
    lines.push(out);
  }
  let roundingLine: ComposedLine | undefined;
  if (entry.roundingLine) {
    const out = await resolve(entry.roundingLine);
    if (typeof out === "string") return { ok: false, detail: `Sin cuenta para el rol ${out}` };
    roundingLine = out;
  }
  return { ok: true, entry: { ...entry, lines, ...(roundingLine ? { roundingLine } : {}) } };
}
