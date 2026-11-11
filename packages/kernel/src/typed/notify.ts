import { createHash, randomUUID } from "node:crypto";
import { MailIdempotencyError, type Mailer, type MailMessage } from "@erp/infra";
import type { Sql } from "postgres";
import { z } from "zod";
import { setAuditContext } from "../audit/audit";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import { SYSTEM_USER_ID } from "../events/consumers";
import { defineProcess } from "../process/define";
import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";
import { IDENTIFIER } from "../registry/fields";
import { translatorFor, type Translate } from "../registry/labels";
import type { EventConsumer } from "../registry/types";
import { renderPrint, type PrintedDocument } from "../templates/processes";
import { validateEmail } from "../validation";
import type { RecordStatus } from "./lifecycle";
import { isTypedEntity } from "./processes";

// State e-mails and Notificar (entity types spec 2026-11-02 §7; Phase 2A.5 Task 12, migration 0049).
//
//  - The lifecycle runner writes `<entity>.status_changed` (StatusChangedPayload) for every status a maestro or documento enters, in the
//    action's transaction. `stateMailConsumer` is the kernel's consumer of that event (registered by the module loader for every typed
//    entity): it reads kernel.state_recipients for (entity, new status); with a list it renders the record's PDF with the record template
//    (the company's default, else the built-in one, Task 11) AS THE USER WHOSE ACTION CHANGED THE STATUS — their field visibility, record
//    access and grid rights, under their claims (rule 14: nothing leaves the system that this user could not print; never unmasked
//    service-role data) — sends one mail with the PDF attached through the Mailer seam (rule 6) and logs it in kernel.mail_log.
//    Without a list: no mail and no log row. The recipients go in Bcc (ruling of 2026-11-02): no recipient sees the others' addresses.
//  - Deterministic (fix round 1): the PDF, its file name and the copy are made from the event (its time is the print time), so a retry
//    of the same event sends the same bytes; the hash of what was sent is kept on the row (body_hash) to tell a repeat from a change.
//  - Once per event id (mail_log.event_id is unique): a delivery first leases the event (a row of kernel.mail_claims, taken and released
//    in statements of their own, so nothing is held while it renders and sends and it works through the transaction pooler) and reads
//    the row after; a parallel delivery finds the lease live and throws for a later retry, an expired lease (a delivery that died) is
//    taken over, a redelivered event whose mail was sent sends nothing. A failed send is logged `failed` (with the provider's answer)
//    and the consumer throws, so the outbox retries it; the retry sends with the same row (Resend also receives the event id as its
//    Idempotency-Key; its 409 for that key means a mail went out: logged sent, with a note when the body differs from the one now
//    rendered). A refusal that a retry cannot fix (the actor no longer a member, or no longer
//    allowed to read or print the record) is logged `failed` with its code and not retried: no mail goes out in their name.
//  - The consumer writes mail_log on the service connection it is given (rule 12: the dispatch workflow's step, in the route handler),
//    with the audit context of an event (origin `event`, the event's chain, the system user as actor); the row's `created_by` is the
//    actor whose rights rendered the PDF.
//  - `kernel.record.notify` (Notificar) is a process run as the caller (kind create: the assistant only runs it after a confirmation card,
//    rule 17): validates the addresses (rule 11), renders the PDF as the caller and logs the mail `queued`; once that row is committed
//    it sends (Bcc) and records the outcome, so a sent mail always has its log row.

export const NOTIFY_FEATURE = "kernel.notifications";
/** At most this many addresses per mail: the state lists (kernel.state_recipients.update) and Notificar. */
export const MAX_RECIPIENTS = 50;

// ---------------------------------------------------------------------------------------------------------------------------------
// The Mailer kernel code sends through (rule 6: the interface, never a provider API). Kept on globalThis like the file store: the
// workflow step bundle loads this module a second time and must see what the app (or a test) installed.
// ---------------------------------------------------------------------------------------------------------------------------------
const MAILER_KEY = Symbol.for("erp.kernel.mailer");
const mailerGlobals = globalThis as { [MAILER_KEY]?: Mailer };

/** Installs the Mailer kernel code uses; `undefined` goes back to the default (`infra.mailer()`, chosen by ERP_TARGET). */
export function setMailer(mailer: Mailer | undefined): void {
  mailerGlobals[MAILER_KEY] = mailer;
}

/** The installed Mailer, or the target's from the server environment (Resend in the cloud, SMTP in Docker), built on first use. */
export async function mailer(): Promise<Mailer> {
  const installed = mailerGlobals[MAILER_KEY];
  if (installed) return installed;
  const { infra } = await import("@erp/infra");
  return (mailerGlobals[MAILER_KEY] ??= infra.mailer());
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Copy (rule 24): the catalogue's patterns, filled with the record's facts in the reader's language.
// ---------------------------------------------------------------------------------------------------------------------------------
/** The default subject when the catalogue is not registered: the variables only, no language of its own. */
const SUBJECT_PATTERN = "{tipo} {numero} · {estado}";

/** One line: every run of white space (line breaks included, m1) becomes one space. */
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const fill = (pattern: string, vars: Record<string, string>): string =>
  pattern.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? oneLine(vars[name]!) : whole)).replace(/[ \t]+/g, " ").replace(/ ·\s*$/, "").trim();

/** The longest subject mail_log keeps (0049). */
const MAX_SUBJECT = 300;

interface RecordFacts {
  tipo: string;
  numero: string;
  estado: string;
}

/**
 * What the copy names: the entity (its label), the record (its number, else its display field) and a status, read through the masked
 * view as the reader (a masked or hidden value names nothing), in their language.
 */
async function recordFacts(tx: Tx, entity: ResolvedEntityDef, recordId: string, t: Translate, status?: RecordStatus): Promise<RecordFacts> {
  for (const part of [entity.schema, entity.table]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
  const [row] = await tx.unsafe<{ record: Record<string, unknown> }[]>(`select to_jsonb(v) as record from ${entity.schema}.v_${entity.table} v where v.id = $1`, [recordId]);
  const record = row?.record ?? {};
  const name = entity.fields.some((f) => f.name === "number") && typeof record.number === "string" && record.number ? record.number : record[entity.displayField];
  const code = status ?? (typeof record.status === "string" ? (record.status as RecordStatus) : undefined);
  return {
    tipo: t(entity.label) ?? entity.id,
    // D16: a document without its number yet is named by its ID (`seq`).
    numero: entity.fields.some((f) => f.name === "number") && !(typeof record.number === "string" && record.number) && record.seq != null ? `ID ${String(record.seq)}` : typeof name === "string" || typeof name === "number" ? String(name) : "",
    estado: code ? (t(`grid.values.record_status.${code}`) ?? code) : "",
  };
}

const subjectOf = (t: Translate, facts: RecordFacts) => oneLine(fill(t("common.notify.subject") ?? SUBJECT_PATTERN, { ...facts })).slice(0, MAX_SUBJECT);

/**
 * What identifies the mail's content: the recipients, the subject, the text and every attachment's name, type and bytes. Two sends of
 * the same event with the same hash sent the same mail.
 */
export function mailBodyHash(message: MailMessage): string {
  const content = {
    to: typeof message.to === "string" ? [message.to] : (message.to ?? []),
    bcc: message.bcc ?? [],
    subject: message.subject,
    text: message.text,
    attachments: (message.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content).toString("base64") })),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

const attachmentOf = (printed: PrintedDocument): NonNullable<MailMessage["attachments"]>[number] => ({
  filename: printed.fileName,
  contentType: "application/pdf",
  content: printed.pdf,
});

/** The provider's answer, kept short for the log. */
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/** The maestro or documento `entityId` of `registry`, or `invalid_input`. */
function typedEntity(registry: Registry, entityId: string): ResolvedEntityDef {
  const entity = registry.entities().find((e) => e.id === entityId);
  if (!entity || !isTypedEntity(entity)) {
    throw new ProcessError("invalid_input", `entity ${entityId} is not a maestro or documento`, { details: [`La entidad ${entityId} no es un maestro ni un documento`] });
  }
  return entity;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The state e-mail: the consumer of `<entity>.status_changed`.
// ---------------------------------------------------------------------------------------------------------------------------------
/** The payload the runner writes (StatusChangedPayload, ./runner); anything else is not this consumer's. */
const StatusChanged = z.object({
  entity: z.string().min(1),
  id: z.uuid(),
  from: z.string(),
  to: z.enum(["draft", "saved", "pending", "rejected", "approved", "posted", "voided"]),
  number: z.string().nullable().optional(),
  actorId: z.uuid(),
});

/**
 * The claims of `actorId` in `companyId`, as the access-token hook would issue them now: their active memberships, their roles in the
 * company, their language. Null when they are not an active member of it any more (or are the system user, who has no rights of
 * their own to print with).
 */
async function actorClaims(sql: Sql, companyId: string, actorId: string): Promise<JwtClaims | null> {
  if (actorId === SYSTEM_USER_ID) return null;
  const [row] = await sql<{ tenant_id: string; company_ids: string[]; role_ids: string[]; locale: string | null }[]>`
    select c.tenant_id,
           array(select m.company_id from kernel.memberships m where m.user_id = ${actorId} and m.is_active order by m.company_id) as company_ids,
           array(select mr.role_id from kernel.memberships m join kernel.membership_roles mr on mr.membership_id = m.id
                  where m.user_id = ${actorId} and m.company_id = ${companyId} and m.is_active order by mr.role_id) as role_ids,
           (select u.locale from kernel.users u where u.id = ${actorId}) as locale
    from kernel.companies c where c.id = ${companyId}`;
  if (!row || !row.company_ids.includes(companyId)) return null;
  return { sub: actorId, tenant_id: row.tenant_id, company_ids: row.company_ids, active_company_id: companyId, role_ids: row.role_ids, locale: row.locale ?? "es-419" };
}

/** A read-only process context for `claims` in `tx` (the print reads; it never emits or audits). */
async function readContext(tx: Tx, registry: Registry, claims: JwtClaims, chainId: string): Promise<ProcessContext> {
  const [live] = await tx<{ role_ids: string[] }[]>`select kernel.current_role_ids() as role_ids`;
  const refuse = async () => {
    throw new Error("a state e-mail's print only reads");
  };
  return {
    tx,
    registry,
    companyId: claims.active_company_id,
    tenantId: claims.tenant_id,
    userId: claims.sub,
    roleIds: live?.role_ids ?? [],
    locale: claims.locale,
    origin: "event",
    chainId,
    dryRun: false,
    emit: refuse,
    audit: refuse,
  };
}

interface MailRow {
  id: string;
  status: "queued" | "sent" | "failed";
  recipients: string[];
  body_hash: string | null;
  error: string | null;
}

/** Writes on the service connection with an event's audit context (the row trigger of kernel.mail_log records it). */
async function asEvent<T>(sql: Sql, chainId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await setAuditContext(tx, { origin: "event", chainId, actorUserId: SYSTEM_USER_ID });
    return fn(tx);
  })) as T;
}

/** A parallel delivery of the same event holds its claim: retried later (a plain error, so the outbox retries it). */
export class StateMailInFlight extends Error {
  constructor(eventId: string) {
    super(`state mail of event ${eventId} is being sent by another delivery`);
    this.name = "StateMailInFlight";
  }
}

/** How long a delivery's claim on an event lasts: longer than a render plus a send (the Mailer gives up after 30 s). */
const CLAIM_LEASE = "2 minutes";

/**
 * Runs `fn` holding the claim on event `eventId`'s state e-mail (I4; fix round 2, N1/N2): a lease row in kernel.mail_claims, taken in
 * one statement (its own transaction) and released in another. Nothing is held while `fn` renders and sends — no connection, no
 * session lock — so it works through the transaction pooler and any number of deliveries share the pool. A live lease of another
 * delivery: `StateMailInFlight` (retried later). An expired one (its delivery died): taken over.
 */
async function withEventClaim<T>(sql: Sql, companyId: string, eventId: string, fn: () => Promise<T>): Promise<T> {
  const claimant = randomUUID();
  const [claim] = await sql<{ event_id: string }[]>`
    insert into kernel.mail_claims (event_id, company_id, lease_until, claimed_by)
    values (${eventId}, ${companyId}, now() + ${CLAIM_LEASE}::interval, ${claimant})
    on conflict (event_id) do update set lease_until = excluded.lease_until, claimed_by = excluded.claimed_by
      where kernel.mail_claims.lease_until < now()
    returning event_id`;
  if (!claim) throw new StateMailInFlight(eventId);
  try {
    return await fn();
  } finally {
    // Only this delivery's lease: one that expired and was taken over belongs to the delivery that took it.
    await sql`delete from kernel.mail_claims where event_id = ${eventId} and claimed_by = ${claimant}`;
  }
}

/** The notes on what a state list left out (m6), as kept in mail_log.error; a retry carries them forward (n3). */
const NOTE = /^(invalid_recipients|recipients_truncated):/;
const notesOf = (error: string | null | undefined): string | null => {
  const kept = (error ?? "").split("; ").filter((part) => NOTE.test(part));
  return kept.length > 0 ? kept.join("; ") : null;
};
const withNote = (note: string | null, error: string | null): string | null => [note, error].filter(Boolean).join("; ").slice(0, 1000) || null;

/**
 * The addresses of a state list as they may be sent to (m6): trimmed, lower-cased, valid (rule 11), without repeats, at most
 * MAX_RECIPIENTS. `dropped` names what was left out, for the log.
 */
function sendableAddresses(raw: readonly string[]): { recipients: string[]; dropped: string | null } {
  const recipients: string[] = [];
  const invalid: string[] = [];
  let over = 0;
  for (const value of raw) {
    const email = value.trim().toLowerCase();
    if (validateEmail(email)) invalid.push(value);
    else if (recipients.includes(email)) continue;
    else if (recipients.length >= MAX_RECIPIENTS) over++;
    else recipients.push(email);
  }
  const notes = [
    ...(invalid.length > 0 ? [`invalid_recipients: ${invalid.length} address(es) of the list are not e-mails and were left out`] : []),
    ...(over > 0 ? [`recipients_truncated: ${over} address(es) over the limit of ${MAX_RECIPIENTS} were left out`] : []),
  ];
  return { recipients, dropped: notes.length > 0 ? notes.join("; ") : null };
}

/**
 * The kernel's consumer of `<entity>.status_changed` for the entities of `registry` (see the file comment). Throws only what a retry may
 * fix (the provider failed, a parallel delivery holds the event, the database went away), so the outbox retries; everything else ends
 * here, logged.
 */
export function stateMailConsumer(registry: Registry): EventConsumer {
  return async (ctx, payload) => {
    const parsed = StatusChanged.safeParse(payload);
    if (!parsed.success) return;
    const event = parsed.data;
    const entity = registry.entities().find((e) => e.id === event.entity);
    if (!entity || !isTypedEntity(entity)) return;

    const [list] = await ctx.sql<{ emails: string[] }[]>`
      select emails from kernel.state_recipients where company_id = ${ctx.companyId} and entity = ${entity.id} and status = ${event.to}`;
    if ((list?.emails ?? []).length === 0) return;

    await withEventClaim(ctx.sql, ctx.companyId, ctx.event.id, async () => {
      // Under the claim: what an earlier delivery left. Sent: nothing to do. Otherwise its recipients (the mail it may have sent).
      const [logged] = await ctx.sql<MailRow[]>`select id, status, recipients, body_hash, error from kernel.mail_log where event_id = ${ctx.event.id}`;
      if (logged?.status === "sent") return;
      const fresh = sendableAddresses(list!.emails);
      const recipients = logged && logged.recipients.length > 0 ? logged.recipients : fresh.recipients;
      // n3: what the list left out, noted by the first attempt, stays on the row through every retry.
      const note = logged ? notesOf(logged.error) : fresh.dropped;

      const log = async (outcome: { status: MailRow["status"]; error?: string | null; providerId?: string | null; subject?: string | null; templateId?: string | null; templateVersion?: number | null; bodyHash?: string | null }): Promise<MailRow> =>
        asEvent(ctx.sql, ctx.chainId, async (tx) => {
          const [row] = await tx<MailRow[]>`
            insert into kernel.mail_log (company_id, entity, record_id, recipients, template_id, template_version, status, provider_id, created_by, event_id, subject, error, body_hash)
            values (${ctx.companyId}, ${entity.id}, ${event.id}, ${recipients}, ${outcome.templateId ?? null}, ${outcome.templateVersion ?? null}, ${outcome.status},
                    ${outcome.providerId ?? null}, ${event.actorId}, ${ctx.event.id}, ${outcome.subject ?? null}, ${outcome.error ?? null}, ${outcome.bodyHash ?? null})
            on conflict (event_id) where event_id is not null
            do update set status = excluded.status, provider_id = excluded.provider_id, error = excluded.error
            returning id, status, recipients, body_hash, error`;
          return row!;
        });

      if (recipients.length === 0) {
        await log({ status: "failed", error: note ?? "no_valid_recipients: the list has no valid address" });
        return;
      }

      // The PDF and the copy, with the actor's rights and in the actor's language, as of the event (its time is the print time).
      const claims = await actorClaims(ctx.sql, ctx.companyId, event.actorId);
      if (!claims) {
        await log({ status: "failed", error: withNote(note, "actor_unavailable: the user whose action changed the status is no longer an active member of the company") });
        return;
      }
      const t = translatorFor(claims.locale);
      let printed: PrintedDocument;
      let facts: RecordFacts;
      try {
        ({ printed, facts } = await withClaims(ctx.sql, claims, async (tx) => {
          const read = await readContext(tx, registry, claims, ctx.chainId);
          return {
            printed: await renderPrint(read, { entity: entity.id, recordId: event.id }, t, { printedAt: ctx.event.createdAt }),
            facts: await recordFacts(tx, entity, event.id, t, event.to),
          };
        }));
      } catch (error) {
        // The actor may not print the record any more (record access, a role or a hidden menu, the record gone): nothing in their name.
        if (error instanceof ProcessError) {
          await log({ status: "failed", error: withNote(note, `${error.code}: ${error.message}`) });
          return;
        }
        throw error;
      }

      const subject = subjectOf(t, facts);
      const message: MailMessage = {
        bcc: recipients,
        subject,
        text: fill(t("common.notify.state_body") ?? SUBJECT_PATTERN, { ...facts }),
        attachments: [attachmentOf(printed)],
        idempotencyKey: ctx.event.id,
      };
      const bodyHash = mailBodyHash(message);
      const template = { subject, templateId: printed.template.id, templateVersion: printed.template.version };
      // The first attempt keeps its hash (the row's render facts never change); a retry compares against it.
      const queued = await log({ status: "queued", error: note, bodyHash, ...template });
      try {
        const result = await (await mailer()).send(message);
        await log({ status: "sent", providerId: result.providerId ?? null, error: note, ...template });
      } catch (error) {
        if (error instanceof MailIdempotencyError && error.reason === "invalid_idempotent_request") {
          // Resend answers so only when it accepted an earlier request with this key: a mail went out (I3). The same body: it was this
          // mail. Another body (the record changed between attempts, n4): the earlier render went out, not this one; logged sent with the
          // note saying so, and not retried (the provider will never take another body under this key).
          const same = queued.body_hash === bodyHash;
          const why = same
            ? "provider_idempotent_repeat: the provider had already accepted this mail"
            : `provider_idempotent_mismatch: the provider had already accepted a mail for this event with another body (an earlier render was sent, not this one): ${errorText(error)}`;
          await log({ status: "sent", error: withNote(note, why), ...template });
          return;
        }
        await log({ status: "failed", error: withNote(note, errorText(error)), ...template });
        throw error;
      }
    });
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Notificar.
// ---------------------------------------------------------------------------------------------------------------------------------
const notifyInput = z.object({
  entity: z.string().min(1).max(100),
  recordId: z.uuid(),
  /** The addresses (prefilled by the dialog from the current status's list, editable). */
  to: z.array(z.string().max(200)).min(1, "Indica al menos un destinatario").max(MAX_RECIPIENTS, `Máximo ${MAX_RECIPIENTS} destinatarios`),
  /** Absent: «{tipo} {numero} · {estado}» in the caller's language. */
  /** One cap, the one its message states (n7): at most 300 characters as typed, then made one line (m1, which only shortens it). */
  subject: z
    .string()
    .max(MAX_SUBJECT, `Máximo ${MAX_SUBJECT} caracteres`)
    .transform(oneLine)
    .pipe(z.string().min(1, "Indica el asunto"))
    .optional(),
  /** The body; absent: the catalogue's line naming the record. */
  message: z.string().trim().max(5000, "Máximo 5000 caracteres").optional(),
});

/** The addresses trimmed, lower-cased and without repeats, or `invalid_input` naming every one that is not an e-mail (rule 11). */
function checkedAddresses(raw: readonly string[]): string[] {
  const out: string[] = [];
  const problems: string[] = [];
  for (const value of raw) {
    const email = value.trim().toLowerCase();
    const problem = validateEmail(email);
    if (problem) problems.push(`${value.trim()}: ${problem}`);
    else if (!out.includes(email)) out.push(email);
  }
  if (problems.length > 0) throw new ProcessError("invalid_input", "invalid recipient addresses", { details: problems });
  return out;
}

type AsCaller = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * Records Notificar's outcome on its committed `queued` row (n5): the mail has already gone (or failed), so a failure to write it is
 * retried (`attempts` times, waiting `waitMs` more each time) and every failed write is logged; if none succeeds the row stays
 * `queued` and the log says what the outcome was. Never thrown: the caller is answered with the send's outcome, which is the truth.
 */
export async function recordNotifyOutcome(
  asCaller: AsCaller,
  mailLogId: string,
  outcome: { status: "sent" | "failed"; providerId: string | null; error: string | null },
  options: { attempts?: number; waitMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await asCaller((tx) => tx`update kernel.mail_log set status = ${outcome.status}, provider_id = ${outcome.providerId}, error = ${outcome.error} where id = ${mailLogId}`);
      return true;
    } catch (error) {
      console.error(`Notificar: recording mail_log ${mailLogId} as ${outcome.status} failed (attempt ${attempt} of ${attempts})`, error);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, (options.waitMs ?? 200) * attempt));
    }
  }
  console.error(`Notificar: mail_log ${mailLogId} stays queued although the mail was ${outcome.status} (provider id ${outcome.providerId ?? "none"})`);
  return false;
}

export const recordNotify = defineProcess({
  id: "kernel.record.notify",
  module: "kernel",
  // A write: it sends a message out of the system (and logs it), so the assistant only runs it after a confirmation card (rule 17).
  kind: "create",
  // The caller must be able to read the record: renderPrint reads it through the masked view as them and refuses one they cannot read
  // exactly as one that does not exist (not_found, the leak rule of Task 9).
  recordAccess: "handler",
  feature: NOTIFY_FEATURE,
  description:
    "Envía por correo el PDF de un registro de un maestro o documento (Notificar) a los destinatarios indicados, con asunto y mensaje; el PDF sale con lo que el usuario puede ver e imprimir",
  input: notifyInput,
  output: z.object({ mailLogId: z.string(), status: z.enum(["queued", "sent", "failed"]) }),
  // Minor 1: the stored idempotency row was written before the send; a replay answers the outcome the log row holds now.
  replay: async (tx, stored) => {
    const [row] = await tx<{ status: "queued" | "sent" | "failed" }[]>`select status from kernel.mail_log where id = ${stored.mailLogId}`;
    return row ? { mailLogId: stored.mailLogId, status: row.status } : stored;
  },
  handler: async (ctx, input) => {
    // Minor 3: only a top-level runProcess run can send after its commit; anywhere else Notificar fails closed, before anything.
    const afterCommit = ctx.afterCommit;
    if (!afterCommit) throw new ProcessError("handler_failed", "kernel.record.notify runs only as a top-level process run (no afterCommit)");
    const entity = typedEntity(ctx.registry, input.entity);
    const to = checkedAddresses(input.to);
    const t = translatorFor(ctx.locale);
    const printed = await renderPrint(ctx, { entity: entity.id, recordId: input.recordId }, t);
    const facts = await recordFacts(ctx.tx, entity, input.recordId, t);
    const subject = input.subject ?? subjectOf(t, facts);
    const text = input.message || fill(t("common.notify.body") ?? SUBJECT_PATTERN, { ...facts });

    const [row] = await ctx.tx<{ id: string }[]>`
      insert into kernel.mail_log (company_id, entity, record_id, recipients, template_id, template_version, status, subject)
      values (${ctx.companyId}, ${entity.id}, ${input.recordId}, ${to}, ${printed.template.id}, ${printed.template.version}, 'queued', ${subject})
      returning id`;
    const output: { mailLogId: string; status: "queued" | "sent" | "failed" } = { mailLogId: row!.id, status: "queued" };
    // m3: the mail goes out only once its `queued` row is committed (a dry run, or a run rolled back, sends nothing), then the outcome
    // is recorded in a transaction of its own as the caller. A failure is logged with the provider's answer; the dialog says to retry.
    afterCommit(async (asCaller) => {
      let outcome: { status: "sent" | "failed"; providerId: string | null; error: string | null };
      try {
        const result = await (await mailer()).send({ bcc: to, subject, text, attachments: [attachmentOf(printed)], idempotencyKey: output.mailLogId });
        outcome = { status: "sent", providerId: result.providerId ?? null, error: null };
      } catch (error) {
        outcome = { status: "failed", providerId: null, error: errorText(error) };
      }
      output.status = outcome.status;
      await recordNotifyOutcome(asCaller, output.mailLogId, outcome);
    });
    return output;
  },
});

export const NOTIFY_PROCESSES = [recordNotify];
