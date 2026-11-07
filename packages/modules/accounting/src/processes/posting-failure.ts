import { composeEntry, defineProcess, dismissParkedEvents, ProcessError, RuleTemplate, visibleExtra, type ComposedLine, type PostingRule, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { invalid } from "./common";
import { reverseEntry } from "./entry-post";
import { lockedSourceVoided, lockSource, recordVoidedSource, SOURCE_VOIDED, sourceOf } from "./voided-source";

export { SOURCE_VOIDED };
import { resolveRoleAccount } from "./mapping";
import { postFromEvent, type ComposedInput } from "./post-from-event";
import { id, rowOutput } from "./schemas";

// The inbox of events that could not post (accounting design §4.9, §5.5): retry re-runs the rule on the stored payload, dismiss
// closes the row with a reason, consult lists them.

interface FailureRow {
  id: string;
  event_id: string;
  event: string;
  posting_rule_id: string | null;
  payload: unknown;
  status: string;
  created_at: Date;
  attempts: number;
}

const codeOf = (error: ProcessError): string => {
  const lead = error.message.split(":")[0] ?? "";
  return /^[a-z_]+$/.test(lead) ? lead : "invalid_template";
};

export const postingRetry = defineProcess({
  id: "accounting.posting.retry",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  description: "Reintenta una regla contable sobre el evento guardado de un pendiente, con la misma clave de idempotencia; si ya cuadra, lo marca como resuelto",
  emits: ["accounting.entry.posted"],
  input: z.object({ failureId: id }).strict(),
  output: z.object({ resolved: z.boolean(), entryId: z.string().optional(), number: z.string().optional(), code: z.string().optional(), detail: z.string().optional() }),
  handler: async (ctx, { failureId }) => {
    const [failure] = await ctx.tx<FailureRow[]>`
      select id, event_id, event, posting_rule_id, payload, status, created_at, attempts
      from accounting.posting_failures where id = ${failureId} and company_id = ${ctx.companyId} for update`;
    if (!failure) throw new ProcessError("not_found", `posting failure ${failureId} not found`);
    // Then the event's outbox row (plan 2B Task 14 review), as accounting.entry.post_from_event takes it, and below the lock of the rule's
    // source (voided-source.ts; lock order: failure row, outbox row, source). The outbox mark itself says nothing here: a delivery that ran
    // leaves it too. What refuses the retry of a voided source is accounting.voided_sources, read under the source lock.
    await ctx.tx`select kernel.lock_event_for(${failure.event_id}, ${"accounting"})`;
    if (failure.status !== "pending") throw invalid(`failure ${failureId} is ${failure.status}`, "Este pendiente ya está resuelto o descartado");
    if (!failure.posting_rule_id) throw invalid(`failure ${failureId} has no rule`, "El pendiente no tiene una regla contable que reintentar");
    const [rule] = await ctx.tx<{ id: string; template: unknown; is_active: boolean }[]>`
      select id, template, is_active from accounting.posting_rules where id = ${failure.posting_rule_id} and company_id = ${ctx.companyId}`;
    if (!rule) throw new ProcessError("not_found", `posting rule ${failure.posting_rule_id} not found`);
    if (!rule.is_active) throw invalid(`rule ${rule.id} is disabled`, "La regla contable está desactivada");
    // The source was voided (review round 2, N1: a pending recorded while the void ran): never posted; the pending is dismissed as the void
    // would have dismissed it, and the retry answers why it did not post.
    if (await lockedSourceVoided(ctx, failure.event, sourceOf(failure.payload, rule.template as PostingRule["template"]))) {
      await ctx.tx`
        update accounting.posting_failures
           set status = 'dismissed', attempts = attempts + 1, last_attempt_at = now(), extra = extra || ${ctx.tx.json({ dismiss_code: SOURCE_VOIDED })}
         where id = ${failureId}`;
      return { resolved: false, code: SOURCE_VOIDED };
    }

    const fail = async (code: string, detail: string) => {
      await ctx.tx`
        update accounting.posting_failures set error_code = ${code}, error_detail = ${detail}, attempts = attempts + 1, last_attempt_at = now() where id = ${failureId}`;
      return { resolved: false, code, detail };
    };
    const [settings] = await ctx.tx<{ rounding_tolerance: string }[]>`select rounding_tolerance from accounting.settings where company_id = ${ctx.companyId}`;
    const template = RuleTemplate.safeParse(rule.template);
    if (!template.success) return fail("invalid_template", template.error.issues.map((i) => i.message).join("; "));
    const composed = composeEntry(template.data, { id: failure.event_id, event: failure.event, payload: failure.payload, createdAt: failure.created_at, chainId: ctx.chainId }, {
      tolerance: Number(settings?.rounding_tolerance ?? 0), companyCurrency: "COP",
    });
    if (!composed.ok) return fail(composed.code, composed.detail);
    const lines: ComposedLine[] = [];
    for (const line of composed.entry.lines) {
      if (line.accountCode || !line.role) {
        lines.push(line);
        continue;
      }
      const account = (line.dimension ? await resolveRoleAccount(ctx, line.role, line.dimension) : null) ?? (await resolveRoleAccount(ctx, line.role));
      if (!account) return fail("missing_account_mapping", `Sin cuenta para el rol ${line.role}${line.dimension ? `:${line.dimension}` : ""}`);
      lines.push({ ...line, accountCode: account.code });
    }

    // The attempt runs in a savepoint: a refusal undoes the half-written entry and is recorded on the row instead of rolling the whole run back.
    try {
      const posted = await ctx.tx.savepoint((sp) =>
        postFromEvent({ ...ctx, tx: sp }, { entry: { ...composed.entry, lines } as unknown as ComposedInput, ruleId: rule.id, eventId: failure.event_id }),
      );
      await ctx.tx`
        update accounting.posting_failures
           set status = 'resolved', resolved_entry_id = ${posted.id}, attempts = attempts + 1, last_attempt_at = now()
         where id = ${failureId}`;
      return { resolved: true, entryId: posted.id, number: posted.number };
    } catch (error) {
      if (error instanceof ProcessError && error.code === "invalid_input") return fail(codeOf(error), Array.isArray(error.details) && error.details.length > 0 ? error.details.join("; ") : error.message);
      throw error;
    }
  },
});

export const postingFailureDismiss = defineProcess({
  id: "accounting.posting_failure.dismiss",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  description: "Descarta un pendiente de contabilizar indicando el motivo; el evento no se contabilizará",
  input: z.object({ failureId: id, reason: z.string().trim().min(1).max(500) }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { failureId, reason }) => {
    const rows = await ctx.tx`
      update accounting.posting_failures
         set status = 'dismissed', extra = extra || ${ctx.tx.json({ dismiss_reason: reason })}
       where id = ${failureId} and company_id = ${ctx.companyId} and status = 'pending'
       returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `pending failure ${failureId} not found`);
    return { id: failureId };
  },
});

export const postingFailureConsult = defineProcess({
  id: "accounting.posting_failure.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.posting",
  description: "Consulta un pendiente de contabilizar por su id, o lista los pendientes por estado",
  input: z.object({ id: id.optional(), status: z.enum(["pending", "resolved", "dismissed"]).optional(), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  output: rowOutput.or(z.looseObject({ failures: z.array(z.looseObject({})) })),
  handler: async (ctx, input) => {
    if (input.id) {
      const [row] = await ctx.tx`select * from accounting.v_posting_failures where id = ${input.id}`;
      if (!row) throw new ProcessError("not_found", `posting failure ${input.id} not found`);
      return { ...row, id: input.id, extra: await visibleExtra(ctx, "accounting.posting_failure", row.extra) };
    }
    const failures = await ctx.tx`
      select * from accounting.v_posting_failures where (${input.status ?? null}::text is null or status = ${input.status ?? null})
      order by created_at desc limit ${input.limit}`;
    return { failures };
  },
});

export const DISMISS_CODE_KEY = "accounting.values.dismiss_code";

/** The jsonb a payload contains when `path` (a plain `$.a.b`, no wildcard) resolves to `value`; null for any other path. */
export function matchOf(path: string, value: string): Record<string, unknown> | null {
  if (!/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) return null;
  return path.slice(2).split(".").reduceRight<Record<string, unknown> | string>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;
}

/**
 * The reversal a rule `reverseOf` orders (plan 2B Task 14 review, round 2): the void of a source reaches the ledger in ONE transaction that
 * every write of the source's own posting serializes with (lock order: failure rows, outbox rows, the source lock of voided-source.ts).
 *   1. The pending failures of the source's event are locked FOR UPDATE (a posting.retry of one of them holds it: this waits, and sees it
 *      resolved afterwards).
 *   2. The source's undelivered events are marked handled (kernel.dismiss_events, their outbox rows locked): a post in flight finishes first,
 *      and the engine never delivers them afterwards.
 *   3. The source lock is taken and the source recorded in accounting.voided_sources: every post, pending record or retry of the source that
 *      takes the lock after this commits finds it and writes nothing (whatever the rule's source path, wildcards included).
 *   4. Only then are the source's pendings read again (FOR UPDATE, skipping a row a waiting retry holds: that retry finds the source voided
 *      and dismisses it itself) and the entry looked for: when it exists (also one a post or a retry just committed) it is reversed; the
 *      source's pendings are dismissed with the code `source_voided`.
 * Only the pendings whose rule's source (template.source.id) resolves to the voided source are dismissed; a pending of another source of
 * the same event, or of a rule without a source, is left as it is.
 */
export const postingReverseSource = defineProcess({
  id: "accounting.posting.reverse_source",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  origins: ["event"],
  description: "Revierte el comprobante de un origen anulado o descarta su pendiente de contabilizar; solo lo ejecuta el motor de contabilización",
  emits: ["accounting.entry.reversed", "accounting.entry.posted"],
  idempotencyKey: (input) => `reverse_source:${input.voidEventId}:${input.event}:${input.sourceId}`,
  input: z.object({ event: z.string().min(1), sourceId: id, voidEventId: id, voidEvent: z.string().min(1), date: z.iso.date() }).strict(),
  output: z.object({ entryId: z.string().nullable(), dismissed: z.array(z.string()) }),
  handler: (ctx, input) => reverseVoidedSource(ctx, input),
});

/**
 * The body of accounting.posting.reverse_source (steps 1–4 above), in the caller's transaction: also what the inline strict reversal of a
 * void runs (the provider's reverseInline, plan 2B Task 33 fix round 1, C1), so an inline void records its source voided and dismisses its
 * pendings exactly as the consumer's does (a pending of the original left by the asynchronous mode never posts afterwards). Throws when the
 * ledger refuses the reversal (a closed period).
 */
export async function reverseVoidedSource(
  ctx: ProcessContext,
  input: { event: string; sourceId: string; voidEventId: string; voidEvent: string; date: string },
): Promise<{ entryId: string | null; dismissed: string[] }> {
  // 1. Lock the event's pendings (only the lock: they are read again below, after the other locks).
  await ctx.tx`
    select f.id from accounting.posting_failures f
    where f.company_id = ${ctx.companyId} and f.event = ${input.event} and f.status = 'pending'
    order by f.id
    for update of f`;

  const rules = await ctx.tx<{ path: string | null }[]>`
    select distinct template #>> '{source,id}' as path from accounting.posting_rules where company_id = ${ctx.companyId} and event = ${input.event}`;
  for (const { path } of rules) {
    const match = path ? matchOf(path, input.sourceId) : null;
    if (match) await dismissParkedEvents(ctx, input.event, match);
  }
  await lockSource(ctx, input.event, input.sourceId);
  await recordVoidedSource(ctx, input.event, input.sourceId, input.voidEventId);
  // Read again after the locks (a pending recorded while this waited is now committed and seen).
  const again = await ctx.tx<{ id: string; payload: unknown; template: PostingRule["template"] | null }[]>`
    select f.id, f.payload, r.template from accounting.posting_failures f left join accounting.posting_rules r on r.id = f.posting_rule_id
    where f.company_id = ${ctx.companyId} and f.event = ${input.event} and f.status = 'pending'
    order by f.id
    for update of f skip locked`;
  const mine = again.filter((row) => sourceOf(row.payload, row.template) === input.sourceId);

  const [entry] = await ctx.tx<{ id: string }[]>`
    select e.id from accounting.entries e join accounting.posting_rules r on r.id = e.posting_rule_id
    where e.company_id = ${ctx.companyId} and e.source_record_id = ${input.sourceId} and r.event = ${input.event} and e.status = 'posted'
      and e.reversal_of_id is null and not coalesce((e.extra->>'reversed')::boolean, false)
    order by e.posted_at limit 1`;
  const reversal = entry ? await reverseEntry(ctx, entry.id, { date: input.date, reason: `Evento ${input.voidEvent}` }, { engine: true }) : null;
  // A pending of another rule of the same source never posts either once the source is void.
  const dismissed: string[] = [];
  for (const row of mine) {
    await ctx.tx`
      update accounting.posting_failures
         set status = 'dismissed', extra = extra || ${ctx.tx.json({ dismiss_code: SOURCE_VOIDED, dismissed_by_event: input.voidEventId })}
       where id = ${row.id}`;
    dismissed.push(row.id);
  }
  return { entryId: reversal?.id ?? null, dismissed };
}

export const POSTING_FAILURE_PROCESSES = [postingRetry, postingFailureDismiss, postingFailureConsult, postingReverseSource];
