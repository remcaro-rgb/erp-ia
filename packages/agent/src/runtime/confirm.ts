import { randomBytes, randomUUID } from "node:crypto";
import { buildConsumerContext, ProcessError, runProcess, withClaims, type Caller, type ProcessDef, type RunProcessDeps } from "@erp/kernel";
import { refusal, type ToolRefusal } from "../tools/descriptor";
import { appendMessage } from "./conversation";
import { buildPreview, postingEffects, type ConfirmationPreview } from "./preview";

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

/** Which card: its token (the bearer secret the tool returned), or its id for the card's own user. */
export type CardRef = string | { token: string } | { cardId: string };

export interface DecisionResult {
  status: "executed" | "rejected";
  result?: unknown;
  /** Why a card ended rejected without the user rejecting it (`confirmation_expired`). */
  reason?: string;
}

/** Whether a run of the process needs a step-up code: the process says so or the company marked it sensitive. */
async function needsStepUp(deps: RunProcessDeps, companyId: string, def: ProcessDef): Promise<boolean> {
  if (def.sensitivity === "step-up") return true;
  const [row] = await deps.sql<{ sensitive: boolean }[]>`
    select exists (select 1 from kernel.sensitive_processes where company_id = ${companyId} and process_id = ${def.id}) as sensitive`;
  return row!.sensitive;
}

/**
 * The active company's country and time zone (`kernel.companies`): its pack labels the card's fiscal codes, and a date and
 * time reads in its zone.
 */
async function companyPlace(deps: RunProcessDeps, companyId: string): Promise<{ country: string | undefined; timeZone: string | undefined }> {
  const [row] = await deps.sql<{ country_code: string; timezone: string }[]>`select country_code, timezone from kernel.companies where id = ${companyId}`;
  return { country: row?.country_code, timeZone: row?.timezone };
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

  const preview = buildPreview(deps.registry, def, parsed.data, {
    locale: claims.locale,
    stepUp: await needsStepUp(deps, claims.active_company_id, def),
    postingEffects: await postingEffects(deps.registry, def, buildConsumerContext(deps.sql, { companyId: claims.active_company_id, chainId: randomUUID() }, deps.registry)),
    ...(await companyPlace(deps, claims.active_company_id)),
  });
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
  token: string;
  company_id: string;
  conversation_id: string;
  process_id: string;
  input: unknown;
  status: Status;
  result: unknown;
  expired: boolean;
  stale: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ProcessError("not_found", "no such confirmation", { stage: "gate" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms or rejects a card as `caller`, named by its token or (for its own user) by its id. The card must be the
 * caller's, in their active company: anyone else (a company admin included) gets `not_found`. Reject marks it
 * `rejected` (also a card a crashed decision left `confirmed`); a rejected card never runs. Confirm runs the process
 * once (see the module comment); `step_up_required` and the process's other refusals put the card back to `pending`
 * and are thrown. A card past its 15 minutes ends `rejected` with the reason `confirmation_expired`: the confirmation
 * that finds it so is answered `invalid_input`, later ones the rejected card. Every decision is told to the
 * conversation (an `event` row) so the next turn knows it. Waiting on another decision is bounded by one deadline
 * (`IN_FLIGHT_WAIT_MS`) for the whole call.
 */
export async function decideConfirmation(deps: RunProcessDeps, caller: Caller, ref: CardRef, decision: Decision, stepUpToken?: string): Promise<DecisionResult> {
  const { claims } = caller;
  const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
  const by = typeof ref === "string" ? { token: ref } : ref;
  if ("cardId" in by && !UUID.test(by.cardId)) throw notFound();
  const staleSecs = STALE_CONFIRMED_MS / 1000;
  // The token column is not readable by signed-in users (0020): the card is found server-side, for this user only.
  const load = async (): Promise<Card | undefined> =>
    (
      await deps.sql<Card[]>`
        select id, token, company_id, conversation_id, process_id, input, status, result, expires_at <= now() as expired,
               coalesce(decided_at < now() - make_interval(secs => ${staleSecs}), false) as stale
        from kernel.agent_confirmations
        where ${"cardId" in by ? deps.sql`id = ${by.cardId}::uuid` : deps.sql`token = ${by.token}`}
          and user_id = ${claims.sub} and company_id = ${claims.active_company_id}`
    )[0];
  /** The run's stored result, when the process already ran with this token (read as the caller, like runProcess). */
  const stored = async (card: Card): Promise<{ result: unknown } | undefined> =>
    (
      await withClaims(deps.sql, claims, (tx) => tx<{ result: unknown }[]>`
        select result from kernel.process_idempotency where company_id = ${card.company_id} and process_id = ${card.process_id} and key = ${card.token}`)
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
  /** pending (or a dead decision's stale `confirmed`) → rejected; true when this call did. */
  const markRejected = async (card: Card, reason?: string): Promise<boolean> =>
    (
      await deps.sql`
        update kernel.agent_confirmations
        set status = 'rejected', decided_at = now(), updated_by = ${claims.sub}, result = ${reason ? deps.sql.json({ reason }) : null}
        where id = ${card.id}
          and (status = 'pending' or (status = 'confirmed' and decided_at < now() - make_interval(secs => ${staleSecs})))
        returning id`
    ).length > 0;

  /** What the card already says, when it is decided; undefined while it is open. */
  const settled = async (card: Card): Promise<DecisionResult | undefined> => {
    if (card.status === "executed") return { status: "executed", result: card.result };
    if (card.status === "rejected") {
      const reason = (card.result as { reason?: unknown } | null)?.reason;
      return typeof reason === "string" ? { status: "rejected", reason } : { status: "rejected" };
    }
    const previous = await stored(card);
    if (previous) {
      if (await markExecuted(card, previous.result)) await tell(card, { status: "executed", result: previous.result ?? null });
      return { status: "executed", result: previous.result };
    }
    return undefined;
  };

  const decide = async (): Promise<DecisionResult> => {
    const card = await load();
    if (!card) throw notFound();
    const done = await settled(card);
    if (done) return done;

    if (decision === "reject") {
      if (await markRejected(card)) {
        await tell(card, { status: "rejected" });
        return { status: "rejected" };
      }
      // A live decision confirmed it meanwhile: answer what that decision ends with.
      return waitForOther(card.id);
    }

    // Past its time a card is not run: it ends rejected (once), and this confirmation is told why.
    if (card.expired && (card.status === "pending" || card.stale)) {
      if (await markRejected(card, "confirmation_expired")) await tell(card, { status: "rejected", reason: "confirmation_expired" });
      throw new ProcessError("invalid_input", "the confirmation expired", { details: ["confirmation_expired"], stage: "gate" });
    }

    // pending → confirmed (or a dead decision's stale `confirmed`): the winner runs the process.
    const claimed = await deps.sql`
      update kernel.agent_confirmations set status = 'confirmed', decided_at = now(), updated_by = ${claims.sub}
      where id = ${card.id}
        and (status = 'pending' or (status = 'confirmed' and decided_at < now() - make_interval(secs => ${staleSecs})))
      returning id`;
    if (claimed.length === 0) return waitForOther(card.id);

    let result: unknown;
    try {
      result = await runProcess(
        deps,
        { claims, origin: "agent", conversationId: card.conversation_id, ...(stepUpToken ? { stepUpToken } : {}) },
        card.process_id,
        card.input,
        { idempotencyKey: card.token },
      );
    } catch (error) {
      // The user can try again (with the step-up code, or after fixing what the process refused).
      await deps.sql`update kernel.agent_confirmations set status = 'pending', decided_at = null where id = ${card.id} and status = 'confirmed'`;
      throw error;
    }
    if (await markExecuted(card, result)) await tell(card, { status: "executed", result: result ?? null });
    return { status: "executed", result };
  };

  /** Another decision holds the card: wait for it to settle or give the card back, until the call's deadline. */
  const waitForOther = async (id: string): Promise<DecisionResult> => {
    while (Date.now() < deadline) {
      await sleep(100);
      const card = await load();
      if (!card || card.id !== id) throw notFound();
      const answer = await settled(card);
      if (answer) return answer;
      // The other decision was refused and gave the card back, or (for a confirmation) died: decide it again, under
      // the same deadline.
      if (card.status === "pending" || (card.stale && decision === "confirm")) return decide();
    }
    throw new ProcessError("idempotent_replay", "the confirmation is being processed", { details: ["confirmation_in_progress"], stage: "gate" });
  };

  return decide();
}
