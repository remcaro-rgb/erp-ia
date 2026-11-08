import { z } from "zod";
import type { Tx } from "../db/client";
import { getServiceDb } from "../db/service";
import { entitled } from "../entitlements/resolver";
import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import { defineProcess } from "../process/define";
import { translatorFor } from "../registry/labels";
import { HOME_FEATURE } from "./kpis";
import { paramValues, reasonKeyOf } from "./recommend";

// The recommendations inbox (design §7.5, rules 25 and 28): what an agent offered the caller's role or the caller. A
// recommendation is offered, never executed: accepting a suggested action only hands it back so the screen opens the
// assistant with it, and the assistant asks for the usual confirmation card. Rows are written by the agents (the
// service role) and by registered processes through ctx.recommendations (recommend.ts, migration 0123); the only change a user makes is
// the one decision, through `kernel.recommendation.decide` (a process row has no suggested action: accepting it only answers the status).

const PROCESS_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

/** A suggested action: a registered process with its input to confirm, or a screen to open. */
export const suggestedAction = z.union([
  z.object({ label: z.string().min(1).max(120), processId: z.string().regex(PROCESS_ID), input: z.record(z.string(), z.json()).default({}) }),
  z.object({ label: z.string().min(1).max(120), href: z.string().regex(/^\/(?!\/)[^\s\\]*$/, "an internal path") }),
]);
export type SuggestedAction = z.infer<typeof suggestedAction>;

const recommendation = z.object({
  id: z.uuid(),
  /** `agent`: an agent's (or the seed's) text; `process`: raised by a process, its text composed from `titleKey`/`bodyKey` and `params`. */
  source: z.enum(["agent", "process"]),
  agentProfile: z.string(),
  /** The agent's text; for a process row, the text composed from the application's catalogue (the keys when none is registered). */
  title: z.string(),
  body: z.string(),
  confidence: z.number().nullable(),
  suggestedActions: z.array(suggestedAction),
  createdAt: z.string(),
  /** The raising module (process rows). */
  module: z.string().nullable(),
  reason: z.string().nullable(),
  titleKey: z.string().nullable(),
  bodyKey: z.string().nullable(),
  /** The values the text names, masked per the caller (null when they do not see the field). */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  /** The record it is about, or null when the caller may not consult it (or an agent row names none). */
  subject: z.object({ entity: z.string(), id: z.uuid() }).nullable(),
  occurrences: z.number().int(),
  lastRaisedAt: z.string().nullable(),
});

interface Row {
  id: string;
  source: "agent" | "process";
  agent_profile: string;
  title: string;
  body: string;
  confidence: string | null;
  suggested_actions: unknown;
  created_at: Date;
  module: string | null;
  reason: string | null;
  title_key: string | null;
  body_key: string | null;
  params: unknown;
  subject_entity: string | null;
  subject_id: string | null;
  occurrences: number;
  last_raised_at: Date | null;
}

/** Actions the row stores that no longer parse (an agent wrote them badly) are left out, not shown half-broken. */
function actionsOf(stored: unknown): SuggestedAction[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    const parsed = suggestedAction.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * A catalogue message with its `{name}` arguments filled (a null value reads «—»), for the readers that get no screen of their own (the
 * assistant's consult): plain arguments only; the screens compose the same keys with their ICU formatter. The key when it is not found.
 */
export function composeMessage(translate: (key: string) => string | undefined, key: string, values: Record<string, string | number | null>): string {
  const text = translate(key);
  if (text === undefined) return key;
  return text.replace(/\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}/g, (all, name: string) => (name in values ? String(values[name] ?? "—") : all));
}

export type RecommendationOut = z.infer<typeof recommendation>;

/**
 * The caller's open recommendations, newest first (at most `limit`, 20 by default), and how many are open (`total`, not capped), read in
 * `tx` as the caller through kernel.v_recommendations (masked params and subject, no row about a subject the caller may not read, 0141)
 * and the table's policies; the total counts the same view. The list process answers
 * this; the shell's bell reads it too, as a plain read under RLS (no audit row on every page load).
 */
export async function openRecommendations(
  tx: Tx,
  options: { companyId: string; locale: string; module?: string | null; limit?: number },
): Promise<{ total: number; recommendations: RecommendationOut[] }> {
  const module = options.module ?? null;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 20);
  const rows = await tx<Row[]>`
    select id, source, agent_profile, title, body, confidence, suggested_actions, created_at, module, reason, title_key, body_key, params,
           subject_entity, subject_id, occurrences, last_raised_at
    from kernel.v_recommendations
    where status = 'new' and company_id = ${options.companyId} and (${module}::text is null or module = ${module})
    order by coalesce(last_raised_at, created_at) desc, id desc
    limit ${limit}`;
  const [count] = await tx<{ n: number }[]>`
    select count(*)::int as n from kernel.v_recommendations
    where status = 'new' and company_id = ${options.companyId} and (${module}::text is null or module = ${module})`;
  const translate = translatorFor(options.locale);
  return {
    total: count!.n,
    recommendations: rows.map((r) => {
      const params = paramValues(r.params);
      const reasonKey = reasonKeyOf(r.module, r.reason);
      const values = { ...params, ...(reasonKey && params.reason === undefined ? { reason: composeMessage(translate, reasonKey, params) } : {}) };
      const process = r.source === "process";
      return {
        id: r.id,
        source: r.source,
        agentProfile: r.agent_profile,
        title: process && r.title_key ? composeMessage(translate, r.title_key, values) : r.title,
        body: process && r.body_key ? composeMessage(translate, r.body_key, values) : r.body,
        confidence: r.confidence === null ? null : Number(r.confidence),
        suggestedActions: actionsOf(r.suggested_actions),
        createdAt: r.created_at.toISOString(),
        module: r.module,
        reason: r.reason,
        titleKey: r.title_key,
        bodyKey: r.body_key,
        params,
        subject: r.subject_entity && r.subject_id ? { entity: r.subject_entity, id: r.subject_id } : null,
        occurrences: r.occurrences,
        lastRaisedAt: r.last_raised_at ? r.last_raised_at.toISOString() : null,
      };
    }),
  };
}

const MODULE = /^[a-z][a-z0-9_]*$/;

export const recommendationList = defineProcess({
  id: "kernel.recommendation.list",
  module: "kernel",
  kind: "consult",
  feature: HOME_FEATURE,
  description:
    "Consulta las recomendaciones nuevas que los agentes y los procesos le ofrecen al usuario o a su rol, de la más reciente a la más antigua; opcionalmente las de un módulo",
  input: z.object({ module: z.string().regex(MODULE).max(64).optional() }),
  output: z.object({ recommendations: z.array(recommendation), total: z.number().int() }),
  handler: async (ctx, input) => openRecommendations(ctx.tx, { companyId: ctx.companyId, locale: ctx.locale, module: input.module ?? null }),
});

const decision = z.enum(["accepted", "dismissed"]);

/**
 * Accepting hands a process to the assistant, so the recommendation is only consumed when the caller could ask for it:
 * the process is registered (`invalid_input` when not), the company is entitled to it (`not_entitled`, the kernel is the
 * platform and needs none) and a role of the caller may run it (`forbidden`). A refusal throws, which rolls the decision
 * back: the recommendation stays `new` and the screen says so instead of opening the assistant.
 */
async function requireRunnable(ctx: ProcessContext, processId: string): Promise<void> {
  let process;
  try {
    process = ctx.registry.process(processId);
  } catch {
    throw new ProcessError("invalid_input", `recommendation action names an unregistered process: ${processId}`);
  }
  if (process.module !== "kernel" && !(await entitled(getServiceDb(), ctx.companyId, `process:${processId}`))) {
    throw new ProcessError("not_entitled", `${processId} is not entitled for company ${ctx.companyId}`);
  }
  const [row] = await ctx.tx<{ allowed: boolean }[]>`select kernel.can_run_process(${processId}) as allowed`;
  if (process.permission !== "none" && !row!.allowed) throw new ProcessError("forbidden", `no role of the caller may run ${processId}`);
}

export const recommendationDecide = defineProcess({
  id: "kernel.recommendation.decide",
  module: "kernel",
  kind: "update",
  feature: HOME_FEATURE,
  description: "Acepta o descarta una recomendación; al aceptar devuelve la acción sugerida para que el asistente pida la confirmación",
  input: z.object({ id: z.uuid(), decision, action: z.number().int().min(0).max(4).default(0) }),
  output: z.object({
    id: z.uuid(),
    status: decision,
    /** The suggested process and its input: the screen opens the assistant with them, which asks for the confirmation. */
    open: z.object({ processId: z.string(), input: z.record(z.string(), z.json()) }).optional(),
    /** The screen a suggested link action opens. */
    href: z.string().optional(),
  }),
  // The same decision again is the same answer (idempotent, rule 36); a different one is refused.
  handler: async (ctx, input) => {
    const updated = await ctx.tx<{ suggested_actions: unknown }[]>`
      update kernel.recommendations
      set status = ${input.decision}, decided_at = now(), decided_by = ${ctx.userId}
      where id = ${input.id} and company_id = ${ctx.companyId} and status = 'new'
        -- Only a row the caller sees (0141: not one about a subject they may not read, which they could otherwise dismiss for everyone).
        and exists (select 1 from kernel.v_recommendations v where v.id = ${input.id})
      returning suggested_actions`;
    let stored = updated[0]?.suggested_actions;
    // Only the call that takes the decision opens the action; a repeat (or somebody else of the audience later) gets the status.
    const first = updated[0] !== undefined;
    if (!updated[0]) {
      // Already decided, or not the caller's to see: the view tells which.
      const [current] = await ctx.tx<{ status: string; suggested_actions: unknown }[]>`
        select status, suggested_actions from kernel.v_recommendations where id = ${input.id} and company_id = ${ctx.companyId}`;
      if (!current) throw new ProcessError("not_found", `recommendation ${input.id} not found`);
      if (current.status !== input.decision) throw new ProcessError("handler_failed", `recommendation ${input.id} was already ${current.status}`);
      stored = current.suggested_actions;
    }
    if (input.decision === "dismissed") return { id: input.id, status: "dismissed" as const };
    if (!first) return { id: input.id, status: "accepted" as const };

    const actions = actionsOf(stored);
    const action = actions[input.action];
    if (!action) {
      if (actions.length === 0 && input.action === 0) return { id: input.id, status: "accepted" as const };
      throw new ProcessError("invalid_input", `recommendation ${input.id} has no action ${input.action}`);
    }
    if ("processId" in action) await requireRunnable(ctx, action.processId);
    return "processId" in action
      ? { id: input.id, status: "accepted" as const, open: { processId: action.processId, input: action.input } }
      : { id: input.id, status: "accepted" as const, href: action.href };
  },
});
