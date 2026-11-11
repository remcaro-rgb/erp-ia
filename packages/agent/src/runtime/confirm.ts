import { randomBytes, randomUUID } from "node:crypto";
import { assertRecordRight, buildConsumerContext, ProcessError, recordGuardOf, runProcess, withClaims, type Caller, type ProcessDef, type RunProcessDeps } from "@erp/kernel";
import { refusal, type ToolRefusal } from "../tools/descriptor";
import { appendMessage } from "./conversation";
import { buildPreview, cardEffects, catalogueOf, message, type ConfirmationPreview, type DryRunEvent } from "./preview";

// Confirmation cards (design §6 "Agent", §7.1, rules 15 and 17, review focus 4): a write-kind tool never runs. It
// validates the input with the process's schema, tries it in a dry run (nothing written; a refusal comes back instead of a card),
// stores the proposal with a random token and returns the card; the
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

// What a refusal tells the model (rules 14 and 17, plan 2B Task 25 fix round 1). A dry run's refusal reaches the model before any card
// exists, and a handler fills its text from what it read, often a module's published view that the caller's field masks do not cover (an
// invoice's number and open amount, a party's legal name): passing that text on would be a read path around the masks, and a party's name
// would put text anyone can type into the model's context. So a refusal carries its code and a catalogue text for it; the handler's own
// text never passes, unless it is one of an explicit allowlist, each checked against what it may say (default deny):
// - `not_invoice_ready`: the readiness reasons (`faltan datos DIAN: Dirección`), each one matched against those `readinessReasons`
//   generates, under a fixed subject (`El cliente`, `Línea 2: el producto`) without the customer's or the product's name;
// - the input schema's field errors (`lines.0.qty: …`), which describe what the model itself sent;
// - the structured ids and names the kernel's gate refusals carry (`{ entity, recordId, right }`, `{ from, action }`).
// The text of a handler's subcode (`allocation_exceeds_open: …`) is `agent.refusal.reason.<subcode>`, else the process's module's
// `<module>.errors.<subcode>`, else any module's; a refusal without a known one is the code's `errors.<code>`. Catalogue texts are fixed
// strings with no record data. A consult's refusal (tools/execute.ts) goes through the same function.

/** The readiness reasons `readinessReasons` writes (sales, invoicing and payments keep the same list). */
const READINESS_REASONS = new Set([
  "no fue aprobado", "está pendiente de aprobación", "está en borrador, sin grabar", "no está habilitado para documentos", "está inactivo",
  "revisa sus datos DIAN, sus archivos, que esté activo y aprobado",
]);
/** A listed reason: the missing DIAN fields or required files, by their labels. */
const READINESS_LIST = /^(faltan datos DIAN|faltan archivos): ([\p{L}\p{N} .()/-]{1,60}(?:, [\p{L}\p{N} .()/-]{1,60})*)$/u;
const READINESS_MARK = /no está listo para (facturar|recibirle pagos): /gu;
const SUBCODE = /^([a-z][a-z0-9_]{1,63}): /;
const DETAIL_KEYS = ["entity", "recordId", "right", "field", "lineId", "from", "action", "reason"] as const;
const DETAIL_VALUE = /^[\w.:-]{1,64}$/;

const isReadinessReason = (reason: string) => READINESS_REASONS.has(reason) || READINESS_LIST.test(reason);

/** One readiness line without its names: the subject, then the reasons after the last marker (the generated ones), each matched. */
function readinessLine(detail: string): string | undefined {
  const line = /^Línea (\d{1,4}): el producto /u.exec(detail);
  if (!line && !detail.startsWith("El cliente ")) return undefined;
  const last = [...detail.matchAll(READINESS_MARK)].at(-1);
  if (!last) return undefined;
  const reasons = detail.slice(last.index + last[0].length).split("; ").filter(isReadinessReason);
  if (reasons.length === 0) return undefined;
  return `${line ? `Línea ${line[1]}: el producto` : "El cliente"} no está listo para ${last[1]}: ${reasons.join("; ")}`;
}

/** The structured details of a gate refusal, ids and names only; undefined when none is left. */
function structuredDetails(details: unknown): Record<string, string> | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const kept = Object.fromEntries(
    DETAIL_KEYS.flatMap((key) => {
      const value = (details as Record<string, unknown>)[key];
      return typeof value === "string" && DETAIL_VALUE.test(value) ? [[key, value]] : [];
    }),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * The refusal the model reads for `error` (see above): the code, a catalogue text in the caller's `locale` and only allowlisted details.
 * `processId` names the refused process, whose module's catalogue texts its subcodes first.
 */
export function scrubRefusal(error: ProcessError, options: { locale: string; processId?: string }): ToolRefusal {
  const catalogue = catalogueOf(options.locale);
  const generic = message(catalogue, `errors.${error.code}`) ?? message(catalogue, "errors.unknown") ?? error.code;
  if (error.code === "invalid_input" && error.stage === "gate") {
    const fieldErrors = Array.isArray(error.details) ? error.details.filter((d): d is string => typeof d === "string") : [];
    return refusal("invalid_input", { message: generic, ...(fieldErrors.length > 0 ? { details: fieldErrors } : {}) });
  }
  const subcode = SUBCODE.exec(error.message)?.[1];
  if (!subcode) {
    const details = structuredDetails(error.details);
    return refusal(error.code, { message: generic, ...(details ? { details } : {}) });
  }
  const moduleId = options.processId?.split(".")[0];
  const reason =
    message(catalogue, `agent.refusal.reason.${subcode}`) ??
    (moduleId ? message(catalogue, `${moduleId}.errors.${subcode}`) : undefined) ??
    Object.keys(catalogue).map((ns) => message(catalogue, `${ns}.errors.${subcode}`)).find((text) => text !== undefined) ??
    generic;
  if (subcode === "not_invoice_ready") {
    const lines = (Array.isArray(error.details) ? error.details : [error.message.slice(subcode.length + 2)])
      .map((d) => (typeof d === "string" ? readinessLine(d) : undefined))
      .filter((d): d is string => d !== undefined);
    if (lines.length > 0) return refusal(error.code, { message: `${subcode}: ${lines[0]}`, details: lines });
  }
  const details = structuredDetails(error.details);
  return refusal(error.code, { message: `${subcode}: ${reason}`, ...(details ? { details } : {}) });
}

/** Whether a run of the process needs a step-up code: the company marked it sensitive, or the process says so and the company did not exempt it. */
async function needsStepUp(deps: RunProcessDeps, companyId: string, def: ProcessDef): Promise<boolean> {
  // Rule 15 (owner 2026-11-11): the company may exempt a process whose definition asks for the step-up (mode `exempt`).
  const [row] = await deps.sql<{ mode: string | null }[]>`
    select (select mode from kernel.sensitive_processes where company_id = ${companyId} and process_id = ${def.id}) as mode`;
  const mode = row?.mode ?? null;
  if (mode === "exempt") return false;
  return mode !== null || def.sensitivity === "step-up";
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
 * input stores nothing and comes back as an `invalid_input` refusal with the issues, for the model to correct; so does
 * any refusal of the process's dry run as the caller (a step-up process excepted), scrubbed to its code and a catalogue text (scrubRefusal).
 * Service connection (the agent's bookkeeping); the conversation must be the caller's, in the active company.
 */
export async function createConfirmation(deps: RunProcessDeps, caller: Caller, def: ProcessDef, input: unknown): Promise<ConfirmationRequired | ToolRefusal> {
  const { claims } = caller;
  if (!caller.conversationId) return refusal("invalid_input", { message: "a write needs a conversation to confirm in" });
  const parsed = def.input.safeParse(input);
  if (!parsed.success) return refusal("invalid_input", { details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  // Record-level access (spec 2026-11-02 §9.1, Phase 2A.5 Task 17): a card never proposes a change to a maestro or documento the caller
  // cannot change. The same guard and refusal `runProcess` applies on the accept (it checks again then): `record_forbidden` for one they
  // read without the right, `not_found` without details for one they cannot read. As the caller.
  const guard = recordGuardOf(deps.registry, def, parsed.data);
  if (guard) {
    try {
      await withClaims(deps.sql, claims, (tx) => assertRecordRight({ tx }, guard.entity, guard.recordId, guard.right));
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
      return error.code === "not_found" ? refusal("not_found") : scrubRefusal(error, { locale: claims.locale, processId: def.id });
    }
  }

  // A card only for what would run now (rules 10 and 17, plan 2B Task 25): the process runs as the caller in a dry run, whose transaction
  // is always rolled back (nothing is written, no event, no audit row, a denial is counted), and its refusal goes back to the model instead of a card:
  // a customer or product that is not invoice_ready, a closed period, an order that cannot be confirmed. A step-up process is not tried
  // (it skips this preflight): its run needs the code, which the user types on the card, so its refusals come at the confirmation (which
  // checks everything again) and its card lists the effects of the events it declares, without the posting rules that have a `when`.
  // The preflight runs the handler once more than the accept does, counts a denial as telemetry without an audit row (rule 16, design §22.28), and holds its row locks until the rollback.
  const stepUp = await needsStepUp(deps, claims.active_company_id, def);
  let events: DryRunEvent[] | undefined;
  if (!stepUp) {
    try {
      // What the run would emit, so the card lists the effects of those events only, each posting rule's `when` checked on its payload.
      await runProcess(deps, caller, def.id, parsed.data, { dryRun: true, preflight: "assistant", onDryRunEvents: (e) => (events = e) });
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
      // Its code and a catalogue text only (scrubRefusal): the handler's text may hold what the caller's masks hide.
      return scrubRefusal(error, { locale: claims.locale, processId: def.id });
    }
  }

  const preview = buildPreview(deps.registry, def, parsed.data, {
    locale: claims.locale,
    stepUp,
    // What the other modules and the ledger will do (design §5.1, plan 2B Task 25): "Inventario: …", "Contabilidad: asiento en Ventas".
    postingEffects: await cardEffects(deps.registry, def, buildConsumerContext(deps.sql, { companyId: claims.active_company_id, chainId: randomUUID() }, deps.registry), { locale: claims.locale, events }),
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
