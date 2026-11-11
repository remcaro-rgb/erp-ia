import { resolvePath, type PostingRule, type ProcessContext } from "@erp/kernel";

// The sources the posting engine has seen voided (plan 2B Task 14, review round 2; migration 0089). One transaction lock per (event, source)
// serializes everything that writes the posting of one source: accounting.posting.reverse_source (the void), accounting.entry.post_from_event
// (the post), accounting.posting_failure.record (a pending) and accounting.posting.retry. The void records the source in
// accounting.voided_sources under that lock, so each of the others, once it holds the lock, either committed before the void (the void then
// finds its entry or its pending) or finds the source voided and writes nothing.
// Lock order everywhere: posting failure rows, then the event's outbox row (kernel.lock_event_for / kernel.dismiss_events), then this lock.

/**
 * The code a pending dismissed by the void of its source carries (`extra.dismiss_code`): a code, not copy (rule 24), whose text is the
 * catalogue's `accounting.values.dismiss_code.source_voided`.
 */
export const SOURCE_VOIDED = "source_voided";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The source id a rule's `template.source.id` resolves to on `payload`; null when the rule names no source or it is not a uuid. */
export function sourceOf(payload: unknown, template: PostingRule["template"] | null | undefined): string | null {
  const path = template?.source?.id;
  if (typeof path !== "string") return null;
  try {
    const value = resolvePath(payload, path);
    return value === null || value === undefined || !UUID.test(String(value)) ? null : String(value);
  } catch {
    return null;
  }
}

/** Takes the transaction lock of the posting of `sourceId` for `event`. */
export async function lockSource(ctx: ProcessContext, event: string, sourceId: string): Promise<void> {
  await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`accounting.source:${ctx.companyId}:${event}:${sourceId}`}, 0))`;
}

/** Takes the lock, then answers whether the source was voided (its posting must not be written). */
export async function lockedSourceVoided(ctx: ProcessContext, event: string, sourceId: string | null): Promise<boolean> {
  if (!sourceId) return false;
  await lockSource(ctx, event, sourceId);
  const [row] = await ctx.tx`select 1 from accounting.voided_sources where company_id = ${ctx.companyId} and event = ${event} and source_id = ${sourceId}`;
  return row !== undefined;
}

/** Records `sourceId` as voided for `event` (the caller holds the lock). */
export async function recordVoidedSource(ctx: ProcessContext, event: string, sourceId: string, voidEventId: string): Promise<void> {
  await ctx.tx`
    insert into accounting.voided_sources (company_id, event, source_id, void_event_id)
    values (${ctx.companyId}, ${event}, ${sourceId}, ${voidEventId})
    on conflict (company_id, event, source_id) do nothing`;
}
