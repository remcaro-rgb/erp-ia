import { defineProcess, ProcessError, type PostingRule, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { insertLines } from "./entry";
import { postEntry } from "./entry-post";
import { assertValid, validateLines, type LineInput } from "./entry-validate";
import { lockedSourceVoided, SOURCE_VOIDED, sourceOf } from "./voided-source";

// The posting engine's write path (accounting design §5.1): `entry.post_from_event` creates and posts the comprobante a rule
// composed, and `posting_failure.record` keeps the inbox row of a rule that could not post. Both are restricted to origin `event`:
// no human can pay a step-up for them and the assistant has no tool for them.

const optionalText = z.string().optional();
const composedLine = z.looseObject({
  accountCode: z.string(),
  side: z.enum(["debit", "credit"]),
  amountDoc: z.number().min(0),
  amountCompany: z.number().min(0),
  partyId: optionalText,
  costCenterId: optionalText,
  openAuxiliaryId: optionalText,
  itemId: optionalText,
  businessUnitId: optionalText,
  description: optionalText,
  taxCode: optionalText,
  taxRate: z.number().optional(),
  taxBase: z.number().optional(),
  reference: optionalText,
  dueDate: optionalText,
});

/** The composed entry of the kernel engine with every role already resolved to an account code. */
export const composedEntry = z.looseObject({
  date: z.iso.date(),
  description: z.string(),
  currency: z.string().length(3),
  exchangeRate: z.number().positive(),
  businessUnitId: optionalText,
  source: z.object({ entity: z.string(), id: z.string() }).optional(),
  lines: z.array(composedLine).min(1),
  sourceEventId: z.string(),
  chainId: z.string(),
});
export type ComposedInput = z.infer<typeof composedEntry>;

/** The posting module's id: the delivery marks of kernel.outbox_deliveries name it. */
const ACCOUNTING = "accounting";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates and posts the entry of `(event, rule)` and returns it; answers the first entry when it already exists (redelivery,
 * retry). A refusal throws `invalid_input` whose message leads with the failure code, so the caller's transaction rolls back.
 * Used by the process below and by `posting.retry`, which runs it as the admin who retries (still exempt from account grants: the
 * rule is already an admin's decision).
 */
export async function postFromEvent(ctx: ProcessContext, input: { entry: ComposedInput; ruleId: string; eventId: string }): Promise<{ id: string; number: string }> {
  const { entry } = input;
  const [existing] = await ctx.tx<{ id: string; number: string }[]>`
    select id, number from accounting.entries
    where company_id = ${ctx.companyId} and source_event_id = ${input.eventId} and posting_rule_id = ${input.ruleId}`;
  if (existing) return existing;
  const [rule] = await ctx.tx<{ journal_id: string }[]>`select journal_id from accounting.posting_rules where id = ${input.ruleId} and company_id = ${ctx.companyId}`;
  if (!rule) throw new ProcessError("not_found", `posting rule ${input.ruleId} not found`);

  const lines: LineInput[] = entry.lines.map((line) => ({
    accountCode: line.accountCode, partyId: line.partyId, costCenterId: line.costCenterId, openAuxiliaryId: line.openAuxiliaryId, itemId: line.itemId,
    businessUnitId: line.businessUnitId, description: line.description, taxCode: line.taxCode, taxRate: line.taxRate, taxBase: line.taxBase,
    reference: line.reference, dueDate: line.dueDate,
    debit: line.side === "debit" ? line.amountCompany : 0, credit: line.side === "credit" ? line.amountCompany : 0,
    debitDoc: line.side === "debit" ? line.amountDoc : 0, creditDoc: line.side === "credit" ? line.amountDoc : 0,
  }));
  const header = { journalId: rule.journal_id, date: entry.date, businessUnitId: entry.businessUnitId ?? null, origin: "auto" as const };
  assertValid(await validateLines(ctx, header, lines, "draft", { engine: true }));
  const [inserted] = await ctx.tx<{ id: string }[]>`
    insert into accounting.entries ${ctx.tx({
      company_id: ctx.companyId, journal_id: rule.journal_id, date: entry.date, description: entry.description, currency: entry.currency,
      exchange_rate: entry.exchangeRate, business_unit_id: entry.businessUnitId ?? null, origin: "auto", status: "draft", requires_approval: false, posts: true,
      source_event_id: input.eventId, posting_rule_id: input.ruleId, source_entity: entry.source?.entity ?? null,
      source_record_id: entry.source && UUID.test(entry.source.id) ? entry.source.id : null, chain_id: ctx.chainId,
    })}
    returning id`;
  await insertLines(ctx, inserted!.id, entry.exchangeRate, lines);
  const posted = await postEntry(ctx, inserted!.id, { engine: true });
  return { id: posted.id, number: posted.number };
}

export const entryPostFromEvent = defineProcess({
  id: "accounting.entry.post_from_event",
  module: "accounting",
  kind: "update",
  feature: "accounting.posting",
  origins: ["event"],
  description: "Crea y contabiliza el comprobante que componen las reglas contables para un evento; solo lo ejecuta el motor de contabilización",
  emits: ["accounting.entry.posted"],
  idempotencyKey: (input) => `posting:${input.eventId}:${input.ruleId}`,
  input: z.object({ entry: composedEntry, ruleId: z.uuid(), eventId: z.uuid() }),
  output: z.object({ id: z.string().nullable(), number: z.string().nullable(), dismissed: z.boolean().optional() }),
  auditInput: (input) => ({ ruleId: input.ruleId, eventId: input.eventId, date: input.entry.date, lines: input.entry.lines.length }),
  handler: async (ctx, input) => {
    // The event's outbox row is taken FOR UPDATE first (plan 2B Task 14 review): a dismissal of the event (its source voided before it
    // posted, kernel.dismiss_events, accounting.posting.reverse_source) takes the same row, so the two serialize. Once the row is ours, an
    // entry already written is answered as before (redelivery); else a mark of this module on the event means it was dismissed: nothing posts.
    const [lock] = await ctx.tx<{ handled: boolean }[]>`select kernel.lock_event_for(${input.eventId}, ${ACCOUNTING}) as handled`;
    if (lock?.handled) {
      const [existing] = await ctx.tx<{ id: string; number: string }[]>`
        select id, number from accounting.entries
        where company_id = ${ctx.companyId} and source_event_id = ${input.eventId} and posting_rule_id = ${input.ruleId}`;
      return existing ?? { id: null, number: null, dismissed: true };
    }
    // Then the source's lock (voided-source.ts): a void of the source that committed first recorded it, and nothing is written; a void that
    // comes later waits for this post and reverses its entry. Whatever the rule's source path (a wildcard path is never pre-dismissed).
    const [rule] = await ctx.tx<{ event: string }[]>`select event from accounting.posting_rules where id = ${input.ruleId} and company_id = ${ctx.companyId}`;
    const sourceId = input.entry.source && UUID.test(input.entry.source.id) ? input.entry.source.id : null;
    if (rule && (await lockedSourceVoided(ctx, rule.event, sourceId))) return { id: null, number: null, dismissed: true };
    return postFromEvent(ctx, input);
  },
});

export const postingFailureRecord = defineProcess({
  id: "accounting.posting_failure.record",
  module: "accounting",
  kind: "create",
  recordAccess: "none",
  feature: "accounting.posting",
  origins: ["event"],
  description: "Registra una regla contable que no pudo contabilizar un evento, para el buzón de pendientes; solo lo ejecuta el motor de contabilización",
  emits: ["accounting.posting.failed"],
  input: z.object({
    eventId: z.uuid(),
    event: z.string(),
    eventDate: z.string(),
    ruleId: z.uuid().optional(),
    payload: z.unknown(),
    code: z.enum([
      "unbalanced", "missing_account_mapping", "closed_period", "inactive_account", "missing_party", "missing_cost_center",
      "missing_open_auxiliary", "missing_item", "missing_business_unit", "inactive_dimension", "invalid_template", "no_journal",
    ]),
    detail: z.string(),
  }),
  // `id` null: nothing recorded, the rule's source was voided meanwhile (review round 2, N1).
  output: z.object({ id: z.string().nullable(), dismissed: z.boolean().optional() }),
  auditInput: (input) => ({ eventId: input.eventId, event: input.event, ruleId: input.ruleId, code: input.code }),
  handler: async (ctx, input) => {
    const [pending] = await ctx.tx<{ id: string }[]>`
      select id from accounting.posting_failures
      where company_id = ${ctx.companyId} and event_id = ${input.eventId} and status = 'pending' and posting_rule_id is not distinct from ${input.ruleId ?? null}
      for update`;
    // Lock order of every writer of a source's posting (voided-source.ts): the pending row, the event's outbox row, the source. A source
    // voided before this commits is never left with a live pending: nothing is recorded (an older pending of it is dismissed).
    await ctx.tx`select kernel.lock_event_for(${input.eventId}, ${"accounting"})`;
    if (input.ruleId) {
      const [rule] = await ctx.tx<{ template: PostingRule["template"] }[]>`select template from accounting.posting_rules where id = ${input.ruleId} and company_id = ${ctx.companyId}`;
      if (await lockedSourceVoided(ctx, input.event, sourceOf(input.payload, rule?.template))) {
        if (pending) {
          await ctx.tx`
            update accounting.posting_failures set status = 'dismissed', extra = extra || ${ctx.tx.json({ dismiss_code: SOURCE_VOIDED })} where id = ${pending.id}`;
        }
        return { id: null, dismissed: true };
      }
    }
    let failureId: string;
    if (pending) {
      failureId = pending.id;
      await ctx.tx`
        update accounting.posting_failures
           set error_code = ${input.code}, error_detail = ${input.detail}, attempts = attempts + 1, last_attempt_at = now()
         where id = ${failureId}`;
    } else {
      const [row] = await ctx.tx<{ id: string }[]>`
        insert into accounting.posting_failures ${ctx.tx({
          company_id: ctx.companyId, event_id: input.eventId, event: input.event, event_date: /^\d{4}-\d{2}-\d{2}$/.test(input.eventDate) ? input.eventDate : null,
          posting_rule_id: input.ruleId ?? null, payload: ctx.tx.json((input.payload ?? null) as Parameters<typeof ctx.tx.json>[0]), error_code: input.code, error_detail: input.detail,
        })}
        returning id`;
      failureId = row!.id;
    }
    await ctx.emit("accounting.posting.failed", { failureId, eventId: input.eventId, event: input.event, ruleId: input.ruleId ?? null, code: input.code, detail: input.detail });
    return { id: failureId };
  },
});

export const POST_FROM_EVENT_PROCESSES = [entryPostFromEvent, postingFailureRecord];
