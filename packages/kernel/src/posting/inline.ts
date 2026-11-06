import type { Sql } from "postgres";
import { SYSTEM_USER_ID } from "../events/consumers";
import { moduleStates } from "../admin/modules-state";
import { enqueueEvent } from "../events/outbox";
import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import type { ModuleDef, ConsumerContext } from "../registry/types";
import { composeEntry, ruleApplies, type EventRef } from "./compose";
import { resolveRoles } from "./engine";
import { resolvePath } from "./path";
import type { PostingProvider } from "./provider";

// Inline strict posting (entity types spec §5.2 and D8, controller rulings of Task 9): a documento that posts (contabiliza) puts its
// entry in the ledger in the SAME transaction as the lifecycle action that posts it, and the whole action rolls back when it cannot.
// `emitAndPostStrict` is what its `post` hook calls: it writes the business event to the outbox (the chain and the audit keep it) and
// posts every rule that applies to it right now through the module that provides the PostingProvider (the kernel names no module, rule 4).
// Unlike the asynchronous engine (engine.ts) it never records a posting failure: any refusal throws and runProcess undoes the action.
//  - Only a posting module ENABLED for the company counts (the dispatcher's gate: bought and not switched off). A company without
//    accounting gets `{ posted: false, reason: "accounting_disabled" }`: the action succeeds and the event stays in the outbox, NOT marked
//    handled, so it parks and the accounting consumer posts it when accounting is enabled (plan Task 24).
//  - A ledger that was never started (no start date) is refused: `ledger_not_started`, "Configura la contabilidad". An event dated before
//    the start posts nothing (`before_ledger_start`): it is counted as skipped, as the engine does.
//  - Whatever the module posted or skipped inline, the event is marked as handled by that module (kernel.outbox_deliveries, migration
//    0078): the dispatcher skips it and the engine returns early, so the asynchronous consumer never composes it again, whatever the
//    configuration has become (a mapping removed, a rule added, the ledger start moved): no spurious failure, no second entry.
//  - A reversal rule reverses the entry of its source through the provider's exact lookup (every entry, whoever may read it); a source
//    with no entry (the allocation parked or predated the ledger) reverses nothing. `dismissParkedEvents` lets a document that is voided
//    before its parked event reached the ledger make sure the event never posts afterwards.

export type InlinePosting =
  | { posted: true; eventId: string; entryIds: string[] }
  | { posted: false; eventId: string; reason: "before_ledger_start" | "accounting_disabled" };

const refuse = (code: string, detail: string): never => {
  throw new ProcessError("invalid_input", `${code}: ${detail}`, { details: [detail] });
};

/**
 * The posting date of the event: its own `date`; without one, today in the company's time zone (final review M-5; never UTC, which is
 * already tomorrow in the evening in Colombia). Every posting event in the plan carries its own date.
 */
const dateOf = async (ctx: ProcessContext, payload: unknown): Promise<string> => {
  const own = payload !== null && typeof payload === "object" ? (payload as { date?: unknown }).date : undefined;
  if (typeof own === "string" && /^\d{4}-\d{2}-\d{2}/.test(own)) return own.slice(0, 10);
  const [company] = await ctx.tx<{ today: string }[]>`
    select to_char((now() at time zone coalesce(timezone, 'UTC'))::date, 'YYYY-MM-DD') as today from kernel.companies where id = ${ctx.companyId}`;
  return company?.today ?? new Date().toISOString().slice(0, 10);
};

/** The module that provides posting, and whether the active company has it enabled. */
async function postingModule(ctx: ProcessContext): Promise<{ module: ModuleDef; provider: PostingProvider; enabled: boolean } | null> {
  const module = ctx.registry.modules().find((m) => m.postingProvider !== undefined);
  if (!module) return null;
  const state = (await moduleStates(ctx.tx, ctx.registry)).find((m) => m.id === module.id);
  return { module, provider: module.postingProvider!, enabled: state?.enabled === true };
}

const markHandled = async (ctx: ProcessContext, eventId: string, moduleId: string): Promise<void> => {
  await ctx.tx`select kernel.mark_event_handled(${eventId}::uuid, ${moduleId})`;
};

/**
 * Emits `name` with `payload` and posts its rules in the caller's transaction (see above). `requireRule` makes an event no rule applies to
 * a refusal (`no_rule`), for a documento whose entry is mandatory.
 */
export async function emitAndPostStrict(ctx: ProcessContext, name: string, payload: unknown, options: { requireRule?: boolean } = {}): Promise<InlinePosting> {
  const posting = await postingModule(ctx);
  const eventId = await enqueueEvent(ctx.tx, { companyId: ctx.companyId, event: name, payload, chainId: ctx.chainId });
  // No posting module, or switched off for the company: the event parks in the outbox for the consumer of a later activation.
  if (!posting || !posting.enabled) return { posted: false, eventId, reason: "accounting_disabled" };
  const { provider, module } = posting;
  if (!provider.postInline || !provider.reverseInline) return refuse("no_posting_provider", "El módulo contable no puede contabilizar este documento en línea");

  const createdAt = new Date();
  // The provider's reads need the connection, the company and the event; its writes use the process context.
  const reader: ConsumerContext = {
    sql: ctx.tx as unknown as Sql, companyId: ctx.companyId, chainId: ctx.chainId, event: { id: eventId, name, createdAt },
    runProcess: () => { throw new Error("inline posting runs in the caller's transaction: no nested process"); },
  };
  const date = await dateOf(ctx, payload);
  const starts = await provider.ledgerStartsOn(reader);
  if (starts === null) return refuse("ledger_not_started", "Configura la contabilidad: la empresa aún no inicia su libro contable");
  if (date < starts.toISOString().slice(0, 10)) {
    await provider.countSkipped(reader, eventId);
    await markHandled(ctx, eventId, module.id);
    return { posted: false, eventId, reason: "before_ledger_start" };
  }

  const event: EventRef = { id: eventId, event: name, payload, createdAt, chainId: ctx.chainId };
  const settings = await provider.composeSettings(reader);
  const rules = [...(await provider.rulesFor(reader, name))].sort((a, b) => a.priority - b.priority);
  const entryIds: string[] = [];
  let applied = 0;
  for (const rule of rules) {
    let applies: boolean;
    try {
      applies = ruleApplies(rule.template, payload);
    } catch (error) {
      return refuse("invalid_template", `when: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!applies) continue;
    applied += 1;
    if (rule.template.reverseOf) {
      const ref = rule.template.reverseOf;
      const reversed = await provider.reverseInline(ctx, { event: ref.event, sourceId: String(resolvePath(payload, ref.sourceId) ?? "") }, date, name);
      if (reversed) entryIds.push(reversed.entryId);
      continue;
    }
    const composed = composeEntry(rule.template, event, settings);
    if (!composed.ok) return refuse(composed.code, composed.detail);
    const resolved = await resolveRoles(provider, reader, composed.entry);
    if (!resolved.ok) return refuse("missing_account_mapping", resolved.detail);
    entryIds.push((await provider.postInline(ctx, resolved.entry, rule)).entryId);
  }
  if (applied === 0 && options.requireRule) refuse("no_rule", `No hay una regla contable activa para el evento ${name}`);
  await markHandled(ctx, eventId, module.id);
  return { posted: true, eventId, entryIds };
}

/**
 * Marks as handled by the posting module the company's events `event` whose payload contains `match` that it has not run yet, so they never
 * post: a document voided while its own event is still parked (accounting was off) must not reach the ledger when accounting is enabled.
 * Answers how many it marked (0 when nothing was parked, or no module posts).
 */
export async function dismissParkedEvents(ctx: ProcessContext, event: string, match: Record<string, unknown>): Promise<number> {
  const module = ctx.registry.modules().find((m) => m.postingProvider !== undefined);
  if (!module) return 0;
  const [row] = await ctx.tx<{ n: number }[]>`select kernel.dismiss_events(${module.id}, ${event}, ${ctx.tx.json(match as never)}::jsonb) as n`;
  return Number(row?.n ?? 0);
}

/**
 * Runs `work` in the caller's transaction acting as the system user holding the company's system admin role, exactly as the asynchronous
 * engine posts (its consumer runs the posting process as that user, events/consumers.ts): the posting the rules decide is not narrowed by
 * what the person who triggered the document may read or post (record rules, account grants). Only the request claims of the transaction
 * change (so the `kernel.current_*` helpers, RLS and row defaults see the system user, as for an event); the role stays `authenticated`,
 * and the person's claims are restored afterwards, also when `work` throws. The chain still names the person's action. Valid on the
 * service connection only (`current_role_ids` keeps the system user's role there and nowhere else). For posting providers' inline methods.
 */
export async function asPostingEngine<T>(ctx: ProcessContext, work: () => Promise<T>): Promise<T> {
  const [saved] = await ctx.tx<{ claims: string | null }[]>`select current_setting('request.jwt.claims', true) as claims`;
  const [role] = await ctx.tx<{ id: string }[]>`select id from kernel.roles where company_id = ${ctx.companyId} and is_system and name = 'admin'`;
  if (!role) throw new ProcessError("invalid_input", `no_admin_role: la empresa ${ctx.companyId} no tiene el rol administrador del sistema`);
  const system = {
    role: "authenticated", sub: SYSTEM_USER_ID, tenant_id: ctx.tenantId, company_ids: [ctx.companyId], active_company_id: ctx.companyId, role_ids: [role.id], locale: ctx.locale,
  };
  await ctx.tx`select set_config('request.jwt.claims', ${JSON.stringify(system)}, true)`;
  try {
    return await work();
  } finally {
    // When `work` failed in SQL the transaction is already aborted and about to roll back: do not mask its error with this one.
    await ctx.tx`select set_config('request.jwt.claims', ${saved?.claims ?? ""}, true)`.catch(() => undefined);
  }
}
