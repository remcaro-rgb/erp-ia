import { asPostingEngine, ProcessError, ruleApplies, type ConsumerContext, type PostingFailure, type PostingFailureCode, type PostingMode, type PostingProvider, type PostingRule, type RuleTemplate } from "@erp/kernel";
import { postFromEvent, type ComposedInput } from "../processes/post-from-event";
import { reverseVoidedSource } from "../processes/posting-failure";
import { ASYNC_BY_DESIGN } from "./mode";
import { roleAccountQuery } from "../processes/mapping";

// The accounting module as the posting engine's provider (accounting design §5.1). It runs on the service connection of the
// event consumer, so every query names the company; everything it writes goes through the module's own processes.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODES: readonly PostingFailureCode[] = [
  "unbalanced", "missing_account_mapping", "closed_period", "inactive_account", "missing_party", "missing_cost_center",
  "missing_open_auxiliary", "missing_item", "missing_business_unit", "inactive_dimension", "invalid_template", "no_journal",
];

/** The document date of the event: the payload's `date`, else the day the event was written. */
async function eventDate(ctx: ConsumerContext): Promise<string> {
  const [row] = await ctx.sql<{ payload: { date?: unknown } | null; created_at: Date }[]>`
    select payload, created_at from kernel.outbox where id = ${ctx.event.id} and company_id = ${ctx.companyId}`;
  const own = row?.payload && typeof row.payload === "object" ? row.payload.date : undefined;
  return typeof own === "string" && /^\d{4}-\d{2}-\d{2}/.test(own) ? own.slice(0, 10) : (row?.created_at ?? ctx.event.createdAt).toISOString().slice(0, 10);
}

export const accountingProvider: PostingProvider = {
  async rulesFor(ctx, event) {
    const rows = await ctx.sql<{ id: string; event: string; journal_id: string; template: PostingRule["template"]; priority: number }[]>`
      select id, event, journal_id, template, priority from accounting.posting_rules
      where company_id = ${ctx.companyId} and event = ${event} and is_active order by priority, seq`;
    return rows.map((r) => ({ id: r.id, event: r.event, journalId: r.journal_id, template: r.template, priority: r.priority }));
  },

  async resolveAccount(ctx, role, dimension) {
    return roleAccountQuery(ctx.sql, ctx.companyId, role, dimension);
  },

  async ledgerStartsOn(ctx) {
    const [row] = await ctx.sql<{ ledger_starts_on: string | null }[]>`select ledger_starts_on::text from accounting.settings where company_id = ${ctx.companyId}`;
    return row?.ledger_starts_on ? new Date(`${row.ledger_starts_on}T00:00:00Z`) : null;
  },

  async composeSettings(ctx) {
    const [row] = await ctx.sql<{ rounding_tolerance: string; currency_code: string }[]>`
      select s.rounding_tolerance, c.currency_code from kernel.companies c left join accounting.settings s on s.company_id = c.id where c.id = ${ctx.companyId}`;
    return { tolerance: Number(row?.rounding_tolerance ?? 0), companyCurrency: row?.currency_code?.trim() || "COP" };
  },

  async countSkipped(ctx, eventId) {
    await ctx.sql`
      insert into accounting.skipped_events (company_id, outbox_id, event, event_date)
      values (${ctx.companyId}, ${eventId}, ${ctx.event.name}, ${await eventDate(ctx)})
      on conflict (company_id, outbox_id) do nothing`;
  },

  async post(ctx, draft, rule) {
    const result = (await ctx.runProcess("accounting.entry.post_from_event", { entry: draft, ruleId: rule.id, eventId: draft.sourceEventId })) as { id: string | null };
    return { entryId: result.id };
  },

  async reverse(ctx, ref) {
    if (!UUID.test(ref.sourceId)) return null;
    const date = await eventDate(ctx);
    try {
      // One transaction that serializes with every post of the source's own event (accounting.posting.reverse_source): the entry is
      // reversed when it exists, else the source's pending is dismissed and its undelivered events never post (plan 2B Task 14, OD-4).
      const out = (await ctx.runProcess("accounting.posting.reverse_source", {
        event: ref.event, sourceId: ref.sourceId, voidEventId: ctx.event.id, voidEvent: ctx.event.name, date,
      })) as { entryId: string | null };
      return out.entryId ? { entryId: out.entryId } : null;
    } catch (error) {
      if (!(error instanceof ProcessError) || error.code !== "invalid_input") throw error;
      // A reversal the ledger refuses (a closed period) is a pending, like any rule that cannot post; the event is acknowledged.
      const lead = error.message.split(":")[0] ?? "";
      const [row] = await ctx.sql<{ payload: unknown }[]>`select payload from kernel.outbox where id = ${ctx.event.id}`;
      // With the reversal rule's id (whole-branch review F-2.1): accounting.posting.retry re-runs the reversal once the period reopens.
      await accountingProvider.recordFailure(ctx, {
        eventId: ctx.event.id, event: ctx.event.name, eventDate: date, ...(ref.ruleId ? { ruleId: ref.ruleId } : {}), payload: row?.payload ?? null,
        code: (CODES as readonly string[]).includes(lead) ? (lead as PostingFailureCode) : "invalid_template",
        detail: Array.isArray(error.details) && error.details.length > 0 ? error.details.join("; ") : error.message,
      });
      return null;
    }
  },

  // Inline strict posting (a documento that posts, D8): the same write path as the engine, but in the caller's transaction and as the
  // caller; a refusal throws and the surrounding action rolls back, nothing is recorded as a posting failure.
  async postInline(ctx, draft, rule) {
    // As the engine does: not narrowed by the record rules or account grants of the person who triggered the document.
    return asPostingEngine(ctx, async () => {
      const posted = await postFromEvent(ctx, { entry: draft as unknown as ComposedInput, ruleId: rule.id, eventId: draft.sourceEventId });
      return { entryId: posted.id };
    });
  },

  async reverseInline(ctx, ref, date, eventName, voidEventId) {
    if (!UUID.test(ref.sourceId)) return null;
    // The same protocol as accounting.posting.reverse_source, in the caller's transaction and as the engine (plan 2B Task 33 fix round 1, C1):
    // the source's pendings locked, its undelivered events dismissed, the source recorded voided under its lock, the entry reversed when it
    // exists (the lookup sees every entry: "none" means there is none), the source's pendings dismissed. A refusal throws (the void rolls back).
    return asPostingEngine(ctx, async () => {
      const out = await reverseVoidedSource(ctx, { event: ref.event, sourceId: ref.sourceId, voidEventId, voidEvent: eventName, date });
      return out.entryId ? { entryId: out.entryId } : null;
    });
  },

  async recordFailure(ctx, failure: PostingFailure) {
    await ctx.runProcess("accounting.posting_failure.record", failure);
  },

  async effectsFor(ctx, event, payload) {
    const rows = await ctx.sql<{ name: string; template: RuleTemplate }[]>`
      select j.name, r.template from accounting.posting_rules r join accounting.journals j on j.id = r.journal_id
      where r.company_id = ${ctx.companyId} and r.event = ${event} and r.is_active order by r.priority, r.seq`;
    // A rule with a `when` is listed only when the event's payload is known and it holds (a malformed one is left out: the engine records it).
    const applies = (template: RuleTemplate) => {
      if (!Array.isArray((template as { when?: unknown }).when)) return true;
      if (payload === undefined) return false;
      try {
        return ruleApplies(template, payload);
      } catch {
        return false;
      }
    };
    return rows.filter((r) => applies(r.template)).map((r) => `Contabilidad: asiento en ${r.name}`);
  },
  /** A comprobante's own Contabiliza event: the typed lifecycle is posting it in that same run (Task 8b), so no rule may post it again. */
  ignores: (event) => event === "accounting.entry.ready_to_post",

  // The company's posting mode (plan 2B Task 33, R33-1): a column of its settings row; inline strict before accounting is configured.
  async postingMode(ctx) {
    const [row] = await ctx.sql<{ posting_mode: PostingMode }[]>`select posting_mode from accounting.settings where company_id = ${ctx.companyId}`;
    return row?.posting_mode ?? "inline_strict";
  },
  asyncByDesign: ASYNC_BY_DESIGN,
};
