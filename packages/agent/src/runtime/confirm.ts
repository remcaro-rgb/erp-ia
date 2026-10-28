import { randomBytes } from "node:crypto";
import { ProcessError, runProcess, withClaims, type Caller, type ProcessDef, type RunProcessDeps } from "@erp/kernel";
import { refusal, type ToolRefusal } from "../tools/descriptor";
import { appendMessage } from "./conversation";
import { buildPreview, type ConfirmationPreview } from "./preview";

// Confirmation cards (design §6 "Agent", §7.1, rules 15 and 17, review focus 4): a write-kind tool never runs. It
// validates the input with the process's schema, stores the proposal with a random token and returns the card; the
// process runs when the conversation's user confirms it, through `runProcess` as that user with origin `agent`, the
// conversation id and the token as idempotency key.
//
// A decision holds no transaction: the card moves by compare-and-set (`pending` → `confirmed` → `executed`, or
// `pending` → `rejected`), and the run in between is `runProcess`'s own. Two confirmations of one card (double click,
// reconnect): the one that wins the `pending` → `confirmed` step runs the process; the other waits for it (polling the
// card, up to `IN_FLIGHT_WAIT_MS`) and answers the same stored result, or `idempotent_replay` when the run is still
// going. A `confirmed` card nobody finished within `STALE_CONFIRMED_MS` (a crash) is taken over; the idempotency key
// keeps the process from running twice. The stored idempotency result is consulted before the card's expiry, so a
// run that committed answers its result even if marking the card `executed` was lost.

/** How long a card can be confirmed. */
export const CONFIRMATION_TTL_MINUTES = 15;
/** How long a second confirmation waits for the first one's run. */
export const IN_FLIGHT_WAIT_MS = 10_000;
/** A card `confirmed` this long ago without a result belongs to a decision that died: another may take it over. */
export const STALE_CONFIRMED_MS = 2 * 60_000;

export interface ConfirmationRequired {
  confirmationRequired: true;
  /** The card's bearer secret, for the confirm route. Never stored in the conversation (the card id is). */
  token: string;
  cardId: string;
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
  const [inserted] = await deps.sql<{ id: string }[]>`
    insert into kernel.agent_confirmations (company_id, conversation_id, user_id, process_id, input, preview, token, expires_at, created_by)
    select c.company_id, c.id, c.user_id, ${def.id}, ${deps.sql.json(input as never)}, ${deps.sql.json(preview as never)}, ${token},
           now() + make_interval(mins => ${CONFIRMATION_TTL_MINUTES}), c.user_id
    from kernel.agent_conversations c
    where c.id = ${caller.conversationId} and c.user_id = ${claims.sub} and c.company_id = ${claims.active_company_id}
    returning id`;
  if (!inserted) return refusal("not_found", { message: "conversation not found" });
  return { confirmationRequired: true, token, cardId: inserted.id, preview };
}

type Status = "pending" | "confirmed" | "rejected" | "executed";

interface Card {
  id: string;
  company_id: string;
  conversation_id: string;
  process_id: string;
  input: unknown;
  status: Status;
  result: unknown;
  expired: boolean;
  stale: boolean;
}

const notFound = () => new ProcessError("not_found", "no such confirmation", { stage: "gate" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms or rejects the card `token` as `caller`. The card must be the caller's, in their active company: anyone
 * else (a company admin included) gets `not_found`. Reject marks it `rejected`; a rejected card never runs. Confirm runs
 * the process once (see the module comment); `step_up_required` and the process's other refusals put the card back to
 * `pending` and are thrown; a card past its 15 minutes is `invalid_input` (`confirmation_expired`). Every decision is
 * told to the conversation (an `event` row) so the next turn knows it.
 */
export async function decideConfirmation(deps: RunProcessDeps, caller: Caller, token: string, decision: Decision, stepUpToken?: string): Promise<DecisionResult> {
  const { claims } = caller;
  // The token column is not readable by signed-in users (0020): the card is found server-side, for this user only.
  const load = async (): Promise<Card | undefined> =>
    (
      await deps.sql<Card[]>`
        select id, company_id, conversation_id, process_id, input, status, result, expires_at <= now() as expired,
               coalesce(decided_at < now() - make_interval(secs => ${STALE_CONFIRMED_MS / 1000}), false) as stale
        from kernel.agent_confirmations
        where token = ${token} and user_id = ${claims.sub} and company_id = ${claims.active_company_id}`
    )[0];
  /** The run's stored result, when the process already ran with this token (read as the caller, like runProcess). */
  const stored = async (card: Card): Promise<{ result: unknown } | undefined> =>
    (
      await withClaims(deps.sql, claims, (tx) => tx<{ result: unknown }[]>`
        select result from kernel.process_idempotency where company_id = ${card.company_id} and process_id = ${card.process_id} and key = ${token}`)
    )[0];
  const tell = (card: Card, part: Record<string, unknown>) =>
    appendMessage(deps.sql, { companyId: card.company_id, conversationId: card.conversation_id, role: "event", parts: [{ type: "confirmation", processId: card.process_id, ...part }], userId: claims.sub });
  /** Marks the card executed with the run's result; true when this call did (so it alone tells the conversation). */
  const markExecuted = async (card: Card, result: unknown): Promise<boolean> =>
    (
      await deps.sql`
        update kernel.agent_confirmations set status = 'executed', result = ${deps.sql.json((result ?? null) as never)}, decided_at = now(), updated_by = ${claims.sub}
        where id = ${card.id} and status <> 'executed' and status <> 'rejected' returning id`
    ).length > 0;

  /** What the card already says, when it is decided; undefined while it is open. */
  const settled = async (card: Card): Promise<DecisionResult | undefined> => {
    if (card.status === "executed") return { status: "executed", result: card.result };
    if (card.status === "rejected") return { status: "rejected" };
    const previous = await stored(card);
    if (previous) {
      if (await markExecuted(card, previous.result)) await tell(card, { status: "executed", result: previous.result ?? null });
      return { status: "executed", result: previous.result };
    }
    return undefined;
  };

  let card = await load();
  if (!card) throw notFound();
  const done = await settled(card);
  if (done) return done;

  if (decision === "reject") {
    const rejected = await deps.sql`
      update kernel.agent_confirmations set status = 'rejected', decided_at = now(), updated_by = ${claims.sub}
      where id = ${card.id} and status = 'pending' returning id`;
    if (rejected.length > 0) {
      await tell(card, { status: "rejected" });
      return { status: "rejected" };
    }
    // Someone confirmed it meanwhile: answer what that decision ends with.
    return waitForOther(card.id);
  }

  if (card.expired) throw new ProcessError("invalid_input", "the confirmation expired", { details: ["confirmation_expired"], stage: "gate" });

  // pending → confirmed (or a dead decision's stale `confirmed`): the winner runs the process.
  const claimed = await deps.sql`
    update kernel.agent_confirmations set status = 'confirmed', decided_at = now(), updated_by = ${claims.sub}
    where id = ${card.id}
      and (status = 'pending' or (status = 'confirmed' and decided_at < now() - make_interval(secs => ${STALE_CONFIRMED_MS / 1000})))
    returning id`;
  if (claimed.length === 0) return waitForOther(card.id);

  let result: unknown;
  try {
    result = await runProcess(
      deps,
      { claims, origin: "agent", conversationId: card.conversation_id, ...(stepUpToken ? { stepUpToken } : {}) },
      card.process_id,
      card.input,
      { idempotencyKey: token },
    );
  } catch (error) {
    // The user can try again (with the step-up code, or after fixing what the process refused).
    await deps.sql`update kernel.agent_confirmations set status = 'pending', decided_at = null where id = ${card.id} and status = 'confirmed'`;
    throw error;
  }
  if (await markExecuted(card, result)) await tell(card, { status: "executed", result: result ?? null });
  return { status: "executed", result };

  /** Another decision holds the card: wait for it to settle (or to give the card back), then answer. */
  async function waitForOther(id: string): Promise<DecisionResult> {
    const until = Date.now() + IN_FLIGHT_WAIT_MS;
    while (Date.now() < until) {
      await sleep(100);
      card = await load();
      if (!card || card.id !== id) throw notFound();
      const answer = await settled(card);
      if (answer) return answer;
      // The other decision was refused (step-up, the process's rules) and gave the card back: decide it now.
      if (card.status === "pending" || card.stale) return decideConfirmation(deps, caller, token, decision, stepUpToken);
    }
    throw new ProcessError("idempotent_replay", "the confirmation is being processed", { details: ["confirmation_in_progress"], stage: "gate" });
  }
}
