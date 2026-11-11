import { defineProcess, ProcessError, type Tx } from "@erp/kernel";
import { z } from "zod";

// The age alert of the asynchronous posting mode (plan 2B.2 Task 52.7, owner item 74, rulings R52-5, R52-6). In that mode a contabiliza
// documento commits before its entry; a document that waits too long (its event still queued or dead-lettered, or its posting failed in
// the retry queue: accounting.v_pending_postings, 0129) is offered as a kernel recommendation `posting_age` to whoever may retry postings.
// The scheduler tick of the web runs this check per company (origin scheduler, the kernel's system user), and only when
// `postingAgePlan` says there is something to do (fix round 1, item 107: a quiet tick writes no audit row). It raises one open row per
// document, re-raised (merged) only when the document's state changed, and closes the rows of documents that no longer wait (R38-4: the
// cause is fixed). A row the audience dismissed (Descartar) holds while the document waits in the same state: only a change of state or a
// newer wait raises again (final review I-1; the kernel's R38-5 is untouched, the check simply does not ask). In inline strict mode nothing
// is raised and what is open is closed.

/** The recommendation's reason code. */
export const POSTING_AGE_REASON = "posting_age";
/**
 * Who sees it: the holders of the retry (R52-5). Through the API's audience process, as Task 38's callers address theirs: a process row
 * needs an audience process (0123) and one open row per document and reason cannot be fanned out per role (R38-2).
 */
export const POSTING_AGE_AUDIENCE = "accounting.posting.retry";
/** Minutes a document may wait when the company has no settings row yet (migration 0143's default). */
export const POSTING_ALERT_MINUTES_DEFAULT = 60;

type PendingState = "queued" | "dead" | "failed";

export interface PostingAgePlan {
  mode: "inline_strict" | "asynchronous";
  minutes: number;
  /** Overdue documents without an open row, or whose open row names another state; not those dismissed in the same state since they wait. */
  raise: { entity: string; id: string; state: PendingState; waited: number }[];
  /** Open rows to close: every one in inline strict mode, else those whose document no longer waits. */
  close: { entity: string; id: string }[];
}

/**
 * What the check would do for the caller's active company, read as the caller (the system user, authenticated, under RLS). It reads
 * accounting's settings and pending documents through accounting's published views (`accounting.v_posting_mode`, 0144;
 * `accounting.v_pending_postings`, 0129, scoped to the active company by its definer function), the module's own `accounting.posting_rules`
 * table (the entity each rule names; its own schema, rule 3), and the kernel's recommendations only through the published
 * `kernel.v_recommendations` (0141), open and dismissed rows alike. The scheduler asks it first and runs the process only when `raise` or
 * `close` is not empty; the process acts on the same answer, so the two never disagree. `known` drops entities the server's registry does
 * not load (no subject to name). Known limit: the view hides a row whose subject the system user may not see (0141), so such a row is
 * neither closed nor known as open here (none today: the system admin role reads every document).
 */
export async function postingAgePlan(tx: Tx, companyId: string, known: (entity: string) => boolean = () => true): Promise<PostingAgePlan> {
  const [settings] = await tx<{ posting_mode: PostingAgePlan["mode"]; posting_alert_minutes: number }[]>`
    select posting_mode, posting_alert_minutes from accounting.v_posting_mode where company_id = ${companyId}`;
  const mode = settings?.posting_mode ?? "inline_strict";
  const minutes = settings?.posting_alert_minutes ?? POSTING_ALERT_MINUTES_DEFAULT;
  const open = await tx<{ subject_entity: string | null; subject_id: string | null; state: string | null }[]>`
    select subject_entity, subject_id, params -> 'state' ->> 'value' as state from kernel.v_recommendations
    where company_id = ${companyId} and status = 'new' and module = 'accounting' and reason = ${POSTING_AGE_REASON}`;
  const openRows = open.flatMap((r) => (r.subject_entity && r.subject_id ? [{ entity: r.subject_entity, id: r.subject_id, state: r.state }] : []));
  // The latest Descartar per document and state: it holds while the document keeps waiting in that state.
  const dismissed = await tx<{ subject_entity: string; subject_id: string; state: string | null; decided_at: Date }[]>`
    select subject_entity, subject_id, params -> 'state' ->> 'value' as state, max(decided_at) as decided_at from kernel.v_recommendations
    where company_id = ${companyId} and status = 'dismissed' and module = 'accounting' and reason = ${POSTING_AGE_REASON}
      and subject_entity is not null and subject_id is not null
    group by subject_entity, subject_id, params -> 'state' ->> 'value'`;
  if (mode !== "asynchronous") return { mode, minutes, raise: [], close: openRows.map(({ entity, id }) => ({ entity, id })) };

  // Every document still waiting (any age: a row is closed only once its document no longer waits) and, of those older than the
  // threshold, one per document (a failure first, then a dead letter, then a queued event) with the entity its rule names: the rule's
  // `source.entity`, or for a reversal rule the entity of the rule of the event it reverses.
  const waiting = await tx<{ source_id: string }[]>`select distinct source_id from accounting.v_pending_postings`;
  const aged = await tx<{ source_id: string; state: PendingState; since: Date; waited: number; entity: string | null }[]>`
    with rules as (
      select r.event,
             coalesce(r.template #>> '{source,entity}', (
               select o.template #>> '{source,entity}' from accounting.posting_rules o
               where o.company_id = r.company_id and o.event = r.template #>> '{reverseOf,event}' and o.template #>> '{source,entity}' is not null
               order by o.is_active desc limit 1)) as entity
      from accounting.posting_rules r
      where r.company_id = ${companyId}
    ),
    entities as (select event, min(entity) as entity from rules where entity is not null group by event)
    select distinct on (p.source_id) p.source_id, p.state, p.since, floor(extract(epoch from now() - p.since) / 60)::int as waited, e.entity
    from accounting.v_pending_postings p
    left join entities e on e.event = p.event
    where p.since < now() - make_interval(mins => ${minutes})
    order by p.source_id, case p.state when 'failed' then 0 when 'dead' then 1 else 2 end, p.since`;

  const openState = new Map(openRows.map((r) => [`${r.entity}:${r.id}`, r.state]));
  const dismissedAt = new Map(dismissed.map((d) => [`${d.subject_entity}:${d.subject_id}:${d.state}`, d.decided_at]));
  const still = new Set(waiting.map((w) => w.source_id));
  return {
    mode,
    minutes,
    raise: aged.flatMap((doc) => {
      if (!doc.entity || !known(doc.entity)) return [];
      const key = `${doc.entity}:${doc.source_id}`;
      if (openState.has(key) && openState.get(key) === doc.state) return [];
      const decided = dismissedAt.get(`${key}:${doc.state}`);
      if (!openState.has(key) && decided && decided.getTime() > doc.since.getTime()) return [];
      return [{ entity: doc.entity, id: doc.source_id, state: doc.state, waited: doc.waited }];
    }),
    close: openRows.filter((r) => !still.has(r.id)).map(({ entity, id }) => ({ entity, id })),
  };
}

export const postingAgeCheck = defineProcess({
  id: "accounting.posting.age_check",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  origins: ["scheduler"],
  description:
    "Avisa a quien puede reintentar contabilizaciones de los documentos que esperan su asiento contable más de los minutos configurados (modo asíncrono); lo ejecuta solo el programador de tareas",
  input: z.object({}).strict(),
  output: z.object({ raised: z.number().int(), closed: z.number().int() }),
  handler: async (ctx) => {
    const api = ctx.recommendations;
    if (!api) throw new ProcessError("handler_failed", "accounting.posting.age_check needs the recommendation API of its run");
    const plan = await postingAgePlan(ctx.tx, ctx.companyId, (entity) => {
      try {
        ctx.registry.entity(entity);
        return true;
      } catch {
        return false;
      }
    });
    for (const doc of plan.raise) {
      await api.raise({
        audienceProcess: POSTING_AGE_AUDIENCE,
        subject: { entity: doc.entity, id: doc.id },
        reason: POSTING_AGE_REASON,
        titleKey: "accounting.recommendations.posting_age.title",
        bodyKey: "accounting.recommendations.posting_age.body",
        params: { waited: { value: doc.waited }, minutes: { value: plan.minutes }, state: { value: doc.state } },
      });
    }
    let closed = 0;
    for (const row of plan.close) {
      closed += (await api.close({ subject: row, reason: POSTING_AGE_REASON })).closed;
    }
    return { raised: plan.raise.length, closed };
  },
});

export const POSTING_AGE_PROCESSES = [postingAgeCheck];
