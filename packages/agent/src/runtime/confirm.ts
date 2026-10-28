import { randomBytes } from "node:crypto";
import { ProcessError, runProcess, withClaims, type Caller, type ProcessDef, type RunProcessDeps } from "@erp/kernel";
import { refusal, type ToolRefusal } from "../tools/descriptor";
import { appendMessage } from "./conversation";
import { buildPreview, type ConfirmationPreview } from "./preview";

// Confirmation cards (design §6 "Agent", §7.1, rules 15 and 17, review focus 4): a write-kind tool never runs. It
// validates the input with the process's schema, stores the proposal with a random token and returns the card; the
// process runs when the conversation's user confirms it, through `runProcess` as that user with origin `agent`, the
// conversation id and the token as idempotency key, so a card confirmed twice (double click, reconnect) runs once.

/** How long a card can be confirmed. */
export const CONFIRMATION_TTL_MINUTES = 15;

export interface ConfirmationRequired {
  confirmationRequired: true;
  token: string;
  preview: ConfirmationPreview;
}

export type Decision = "confirm" | "reject";

export interface DecisionResult {
  status: "executed" | "rejected";
  result?: unknown;
}

/** Whether a run of the process needs a step-up code: the process says so or the company marked it sensitive. */
async function needsStepUp(deps: RunProcessDeps, companyId: string, def: ProcessDef): Promise<boolean> {
  if (def.sensitivity === "step-up") return true;
  const [row] = await deps.sql<{ sensitive: boolean }[]>`
    select exists (select 1 from kernel.sensitive_processes where company_id = ${companyId} and process_id = ${def.id}) as sensitive`;
  return row!.sensitive;
}

/**
 * Stores a pending card for a write-kind run of `def` proposed in the caller's conversation and returns it. Invalid
 * input stores nothing and comes back as an `invalid_input` refusal with the issues, for the model to correct.
 * Service connection (the agent's bookkeeping); the conversation must be the caller's, in the active company.
 */
export async function createConfirmation(deps: RunProcessDeps, caller: Caller, def: ProcessDef, input: unknown): Promise<ConfirmationRequired | ToolRefusal> {
  const { claims } = caller;
  if (!caller.conversationId) return refusal("invalid_input", { message: "a write needs a conversation to confirm in" });
  const parsed = def.input.safeParse(input);
  if (!parsed.success) return refusal("invalid_input", { details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });

  const preview = buildPreview(deps.registry, def, parsed.data, { locale: claims.locale, stepUp: await needsStepUp(deps, claims.active_company_id, def) });
  const token = randomBytes(32).toString("base64url");
  const inserted = await deps.sql`
    insert into kernel.agent_confirmations (company_id, conversation_id, user_id, process_id, input, preview, token, expires_at, created_by)
    select c.company_id, c.id, c.user_id, ${def.id}, ${deps.sql.json(input as never)}, ${deps.sql.json(preview as never)}, ${token},
           now() + make_interval(mins => ${CONFIRMATION_TTL_MINUTES}), c.user_id
    from kernel.agent_conversations c
    where c.id = ${caller.conversationId} and c.user_id = ${claims.sub} and c.company_id = ${claims.active_company_id}
    returning id`;
  if (inserted.length === 0) return refusal("not_found", { message: "conversation not found" });
  return { confirmationRequired: true, token, preview };
}

interface Card {
  id: string;
  company_id: string;
  conversation_id: string;
  process_id: string;
  input: unknown;
  status: "pending" | "confirmed" | "rejected" | "executed";
  result: unknown;
  expired: boolean;
}

const notFound = () => new ProcessError("not_found", "no such confirmation", { stage: "gate" });

/**
 * Confirms or rejects the card `token` as `caller`. The card is read as the caller (company RLS) and must be theirs:
 * another user, a company admin included, gets `not_found`. Reject marks it `rejected`; a rejected card never runs.
 * Confirm runs the process under a lock on the card (`step_up_required` and other refusals leave the card pending and
 * are thrown); a card already executed answers its stored result without running again; a card past its 15 minutes
 * is `invalid_input`.
 * Every decision is told to the conversation (an `event` row) so the next turn knows it.
 */
export async function decideConfirmation(deps: RunProcessDeps, caller: Caller, token: string, decision: Decision, stepUpToken?: string): Promise<DecisionResult> {
  const { claims } = caller;
  const [card] = await withClaims(deps.sql, claims, (tx) => tx<Card[]>`
    select id, company_id, conversation_id, process_id, input, status, result, expires_at <= now() as expired
    from kernel.agent_confirmations
    where token = ${token} and user_id = ${claims.sub}`);
  if (!card) throw notFound();

  const tell = (part: Record<string, unknown>) =>
    appendMessage(deps.sql, { companyId: card.company_id, conversationId: card.conversation_id, role: "event", parts: [{ type: "confirmation", processId: card.process_id, ...part }], userId: claims.sub });

  if (card.status === "executed") return { status: "executed", result: card.result };
  if (card.status === "rejected") return { status: "rejected" };

  if (decision === "reject") {
    const rejected = await deps.sql`
      update kernel.agent_confirmations set status = 'rejected', decided_at = now(), updated_by = ${claims.sub}
      where id = ${card.id} and status = 'pending' returning id`;
    if (rejected.length === 0) return decideConfirmation(deps, caller, token, decision, stepUpToken);
    await tell({ status: "rejected" });
    return { status: "rejected" };
  }

  if (card.expired) throw new ProcessError("invalid_input", "the confirmation expired", { details: ["confirmation_expired"], stage: "gate" });

  // One decision at a time per card: a second confirmation (double click, reconnect) waits on the row lock, then finds
  // the card executed and answers its stored result. The token is also the run's idempotency key (review focus 4).
  // A refusal (step-up missing, the process's own rules) rolls the lock transaction back: the card stays pending.
  const outcome = await deps.sql.begin(async (lock) => {
    const [fresh] = await lock<{ status: Card["status"]; result: unknown }[]>`
      select status, result from kernel.agent_confirmations where id = ${card.id} for update`;
    if (fresh!.status === "executed") return { status: "executed" as const, result: fresh!.result, fresh: false };
    if (fresh!.status === "rejected") return { status: "rejected" as const, fresh: false };
    const result = await runProcess(
      deps,
      { claims, origin: "agent", conversationId: card.conversation_id, ...(stepUpToken ? { stepUpToken } : {}) },
      card.process_id,
      card.input,
      { idempotencyKey: token },
    );
    await lock`
      update kernel.agent_confirmations set status = 'executed', result = ${lock.json((result ?? null) as never)}, decided_at = now(), updated_by = ${claims.sub}
      where id = ${card.id}`;
    return { status: "executed" as const, result, fresh: true };
  });
  if (outcome.status === "rejected") return { status: "rejected" };
  if (outcome.fresh) await tell({ status: "executed", result: outcome.result ?? null });
  return { status: "executed", result: outcome.result };
}
