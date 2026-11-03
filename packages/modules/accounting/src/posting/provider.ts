import { ProcessError, type ConsumerContext, type PostingFailure, type PostingFailureCode, type PostingProvider, type PostingRule } from "@erp/kernel";

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
    const [row] = await ctx.sql<{ account_id: string; code: string }[]>`
      select m.account_id, a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
      where m.company_id = ${ctx.companyId} and m.role = ${role} and (m.dimension is null or m.dimension = ${dimension ?? null})
      order by (m.dimension is null) limit 1`;
    return row ? { accountId: row.account_id, code: row.code } : null;
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
    const result = (await ctx.runProcess("accounting.entry.post_from_event", { entry: draft, ruleId: rule.id, eventId: draft.sourceEventId })) as { id: string };
    return { entryId: result.id };
  },

  async reverse(ctx, ref) {
    if (!UUID.test(ref.sourceId)) return null;
    const [entry] = await ctx.sql<{ id: string }[]>`
      select e.id from accounting.entries e join accounting.posting_rules r on r.id = e.posting_rule_id
      where e.company_id = ${ctx.companyId} and e.source_record_id = ${ref.sourceId} and r.event = ${ref.event} and e.status = 'posted' and e.reversal_of_id is null and not coalesce((e.extra->>'reversed')::boolean, false)
      order by e.posted_at limit 1`;
    if (!entry) return null;
    const date = await eventDate(ctx);
    try {
      const out = (await ctx.runProcess("accounting.entry.reverse", { id: entry.id, date, reason: `Evento ${ctx.event.name}` })) as { id: string };
      return { entryId: out.id };
    } catch (error) {
      if (!(error instanceof ProcessError) || error.code !== "invalid_input") throw error;
      // A reversal the ledger refuses (a closed period) is a pending, like any rule that cannot post; the event is acknowledged.
      const lead = error.message.split(":")[0] ?? "";
      const [row] = await ctx.sql<{ payload: unknown }[]>`select payload from kernel.outbox where id = ${ctx.event.id}`;
      await accountingProvider.recordFailure(ctx, {
        eventId: ctx.event.id, event: ctx.event.name, eventDate: date, payload: row?.payload ?? null,
        code: (CODES as readonly string[]).includes(lead) ? (lead as PostingFailureCode) : "invalid_template",
        detail: Array.isArray(error.details) && error.details.length > 0 ? error.details.join("; ") : error.message,
      });
      return null;
    }
  },

  async recordFailure(ctx, failure: PostingFailure) {
    await ctx.runProcess("accounting.posting_failure.record", failure);
  },

  async effectsFor(ctx, event) {
    const rows = await ctx.sql<{ name: string }[]>`
      select j.name from accounting.posting_rules r join accounting.journals j on j.id = r.journal_id
      where r.company_id = ${ctx.companyId} and r.event = ${event} and r.is_active order by r.priority, r.seq`;
    return rows.map((r) => `Contabilidad: asiento en ${r.name}`);
  },
  /** A comprobante's own Contabiliza event: the typed lifecycle is posting it in that same run (Task 8b), so no rule may post it again. */
  ignores: (event) => event === "accounting.entry.ready_to_post",
};
