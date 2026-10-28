import { z } from "zod";
import { getServiceDb } from "../db/service";
import { entitled } from "../entitlements/resolver";
import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import { defineProcess } from "../process/define";
import { HOME_FEATURE } from "./kpis";

// The recommendations inbox (design §7.5, rules 25 and 28): what an agent offered the caller's role or the caller. A
// recommendation is offered, never executed: accepting a suggested action only hands it back so the screen opens the
// assistant with it, and the assistant asks for the usual confirmation card. Rows are written by the agents (the
// service role); the only change a user makes is the one decision, through `kernel.recommendation.decide`.

const PROCESS_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

/** A suggested action: a registered process with its input to confirm, or a screen to open. */
export const suggestedAction = z.union([
  z.object({ label: z.string().min(1).max(120), processId: z.string().regex(PROCESS_ID), input: z.record(z.string(), z.json()).default({}) }),
  z.object({ label: z.string().min(1).max(120), href: z.string().regex(/^\/(?!\/)[^\s\\]*$/, "an internal path") }),
]);
export type SuggestedAction = z.infer<typeof suggestedAction>;

const recommendation = z.object({
  id: z.uuid(),
  agentProfile: z.string(),
  title: z.string(),
  body: z.string(),
  confidence: z.number().nullable(),
  suggestedActions: z.array(suggestedAction),
  createdAt: z.string(),
});

interface Row {
  id: string;
  agent_profile: string;
  title: string;
  body: string;
  confidence: string | null;
  suggested_actions: unknown;
  created_at: Date;
}

/** Actions the row stores that no longer parse (an agent wrote them badly) are left out, not shown half-broken. */
function actionsOf(stored: unknown): SuggestedAction[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    const parsed = suggestedAction.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export const recommendationList = defineProcess({
  id: "kernel.recommendation.list",
  module: "kernel",
  kind: "consult",
  feature: HOME_FEATURE,
  description: "Consulta las recomendaciones nuevas que los agentes le ofrecen al usuario o a su rol, de la más reciente a la más antigua",
  input: z.object({}),
  output: z.object({ recommendations: z.array(recommendation) }),
  handler: async (ctx) => {
    const rows = await ctx.tx<Row[]>`
      select id, agent_profile, title, body, confidence, suggested_actions, created_at
      from kernel.v_recommendations
      where status = 'new' and company_id = ${ctx.companyId}
      order by created_at desc, id desc
      limit 20`;
    return {
      recommendations: rows.map((r) => ({
        id: r.id,
        agentProfile: r.agent_profile,
        title: r.title,
        body: r.body,
        confidence: r.confidence === null ? null : Number(r.confidence),
        suggestedActions: actionsOf(r.suggested_actions),
        createdAt: r.created_at.toISOString(),
      })),
    };
  },
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
