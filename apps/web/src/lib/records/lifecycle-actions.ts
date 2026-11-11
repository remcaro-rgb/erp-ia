"use server";

import { getTranslations } from "next-intl/server";
import { GENERIC_VERBS, type GenericVerb } from "@erp/kernel/typed";
import { ProcessError, runProcess, withClaims, type Caller } from "@erp/kernel";
import type { RecordActionOutcome } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";
import { issuesOf } from "./issues";

// The record action bar's server side (Task 15, rule 1): every button is a registered process run as the session's user — the
// generic lifecycle processes `<entity>.save|submit|approve|reject|void|delete`, `kernel.doc_template.print` (Imprimir),
// `kernel.record.notify` (Notificar) and `kernel.record_access.set` (Acceso). The processes check the rights again (permissions,
// record access, the lifecycle table); the bar only hides what they would refuse. A refusal comes back as data for the inline alert.

const ENTITY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; code: string; messages: string[] };

async function perform<T>(stepUpToken: string | undefined, work: (caller: Caller) => Promise<T>): Promise<Outcome<{ value: T }>> {
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    return { ok: true, value: await work(caller) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) {
      const named = error.code === "maestro_not_usable" ? await notUsableText(caller, error.details) : null;
      return { ok: false, code: error.code, messages: named ? [named] : issuesOf(error.details).map((i) => i.message) };
    }
    throw error;
  }
}

/**
 * A `maestro_not_usable` refusal in words: the field's label and the referenced record's name as the caller may see it (through its
 * masked view; a record they cannot read gets no name, and the generic message stays). `details: { field, entity, recordId, lineId? }`.
 */
async function notUsableText(caller: Caller, details: unknown): Promise<string | null> {
  if (!details || typeof details !== "object") return null;
  const { field, entity, recordId } = details as { field?: unknown; entity?: unknown; recordId?: unknown };
  if (typeof field !== "string" || typeof entity !== "string" || typeof recordId !== "string" || !UUID.test(recordId)) return null;
  const deps = processDeps();
  const target = deps.registry.entities().find((e) => e.id === entity);
  if (!target || !/^[a-z_][a-z0-9_]*$/.test(target.schema) || !/^[a-z_][a-z0-9_]*$/.test(target.table) || !/^[a-z_][a-z0-9_]*$/.test(target.displayField)) return null;
  const owner = deps.registry.entities().flatMap((e) => e.fields).find((f) => f.name === field && f.ref?.entity === entity);
  const t = await getTranslations();
  const rows = await withClaims(deps.sql, caller.claims, (tx) => tx.unsafe<{ name: unknown }[]>(`select ${target.displayField} as name from ${target.schema}.v_${target.table} where id = $1`, [recordId])).catch(() => []);
  const name = rows[0]?.name;
  if (name === null || name === undefined || name === "") return null;
  const label = owner && t.has(owner.label) ? t(owner.label) : field;
  return t("errors.maestro_not_usable_named", { field: label, name: String(name) });
}

/** A click's idempotency key (minor 2, `bar-flow.actionKey`): the run is recorded under it, and the same key again answers that run. */
const KEY = /^bar:[a-z][a-z0-9_.]*:[0-9a-f-]{36}$/;
const keyed = (key: string | undefined) => (typeof key === "string" && KEY.test(key) ? { idempotencyKey: key } : {});

/**
 * Runs the lifecycle verb on the record. `expectedUpdatedAt` is the version the screen shows (a newer one answers `stale_record`).
 * `idempotencyKey` is the click's: a double click runs the step once.
 */
export async function runRecordAction(
  entity: string,
  verb: GenericVerb,
  id: string,
  input: { reason?: string; option?: boolean; expectedUpdatedAt?: string },
  stepUpToken?: string,
  idempotencyKey?: string,
): Promise<RecordActionOutcome & { status?: string; updatedAt?: string }> {
  if (!ENTITY.test(entity) || !UUID.test(id) || !(GENERIC_VERBS as readonly string[]).includes(verb)) return { ok: false, code: "invalid_input", messages: [] };
  const body = {
    id,
    ...(verb === "reject" || verb === "void" ? { reason: input.reason?.trim() ?? "" } : {}),
    // The void's optional question (Task 43: a shipped entrega's «¿Reservar de nuevo…?»): the entity's void process takes it as `reReserve`.
    ...(verb === "void" && typeof input.option === "boolean" ? { reReserve: input.option } : {}),
    ...(typeof input.expectedUpdatedAt === "string" && input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
  };
  const result = await perform(stepUpToken, (caller) => runProcess(processDeps(), caller, `${entity}.${verb}`, body, keyed(idempotencyKey)) as Promise<{ status?: string; number?: string; updatedAt?: string; reReserve?: string }>);
  if (!result.ok) return result;
  const t = await getTranslations("common.record.actions");
  // The promise of a re-reservation only when the server asked inventory for it (not_permitted and none read the neutral «Listo»).
  const message = verb === "void" && input.option === true && result.value.reReserve === "asked" ? t("done_re_reserve") : t("done");
  return { ok: true, message, ...(result.value.status ? { status: result.value.status } : {}), ...(result.value.updatedAt ? { updatedAt: result.value.updatedAt } : {}) };
}

/** Imprimir: the record's PDF with its template, as an export job the caller downloads by its signed link. */
export async function printRecordAction(entity: string, id: string, title?: string): Promise<Outcome<{ fileId: string }>> {
  if (!ENTITY.test(entity) || !UUID.test(id)) return { ok: false, code: "invalid_input", messages: [] };
  const result = await perform(undefined, (caller) =>
    runProcess(processDeps(), caller, "kernel.doc_template.print", { entity, recordId: id, ...(title ? { title: title.slice(0, 120) } : {}) }) as Promise<{ fileId: string }>,
  );
  return result.ok ? { ok: true, fileId: result.value.fileId } : result;
}

/**
 * Imprimir on a grid (Task 16): the list of what the grid shows (its filters, sort and visible columns, every page) with the entity's
 * list template, as an export job the caller downloads by its signed link. Only maestros and documentos print (the process refuses the rest).
 */
export async function printListAction(entity: string, gridState: unknown, title?: string): Promise<Outcome<{ fileId: string }>> {
  if (!ENTITY.test(entity) || typeof gridState !== "object" || gridState === null) return { ok: false, code: "invalid_input", messages: [] };
  const result = await perform(undefined, (caller) =>
    runProcess(processDeps(), caller, "kernel.doc_template.print", { entity, gridState, ...(title ? { title: title.slice(0, 120) } : {}) }) as Promise<{ fileId: string }>,
  );
  return result.ok ? { ok: true, fileId: result.value.fileId } : result;
}

/**
 * «Ver PDF» in the template editor: the saved template printed with the newest record the caller may read (record scope) or the
 * entity's first rows (list scope). A read-only print (kernel.doc_template.print), like Imprimir.
 */
export async function previewTemplateAction(entity: string, scope: "record" | "list", templateId: string): Promise<Outcome<{ fileId: string }>> {
  if (!ENTITY.test(entity) || !UUID.test(templateId) || (scope !== "record" && scope !== "list")) return { ok: false, code: "invalid_input", messages: [] };
  const deps = processDeps();
  const target = deps.registry.entities().find((e) => e.id === entity);
  if (!target || !/^[a-z_][a-z0-9_]*$/.test(target.schema) || !/^[a-z_][a-z0-9_]*$/.test(target.table)) return { ok: false, code: "invalid_input", messages: [] };
  const result = await perform(undefined, async (caller) => {
    let recordId: string | undefined;
    if (scope === "record") {
      const rows = await withClaims(deps.sql, caller.claims, (tx) => tx.unsafe<{ id: string }[]>(`select id from ${target.schema}.v_${target.table} order by id desc limit 1`));
      recordId = rows[0]?.id;
      if (!recordId) throw new ProcessError("not_found", `${entity} has no record to preview with`);
    }
    return runProcess(deps, caller, "kernel.doc_template.print", {
      entity,
      templateId,
      ...(recordId ? { recordId } : { gridState: { filters: [], sort: [], page: 1, pageSize: 50 } }),
    }) as Promise<{ fileId: string }>;
  });
  return result.ok ? { ok: true, fileId: result.value.fileId } : result;
}

/**
 * Notificar: e-mails the record's PDF to the recipients (Bcc), with the subject and message. `idempotencyKey` is the send's: a double
 * click sends one mail and both answer its real outcome (sent / failed / queued).
 */
export async function notifyRecordAction(
  entity: string,
  id: string,
  mail: { to: string[]; subject?: string; message?: string },
  stepUpToken?: string,
  idempotencyKey?: string,
): Promise<Outcome<{ status: "queued" | "sent" | "failed" }>> {
  if (!ENTITY.test(entity) || !UUID.test(id) || !Array.isArray(mail.to)) return { ok: false, code: "invalid_input", messages: [] };
  const result = await perform(stepUpToken, (caller) =>
    runProcess(processDeps(), caller, "kernel.record.notify", {
      entity,
      recordId: id,
      to: mail.to,
      ...(mail.subject?.trim() ? { subject: mail.subject.trim() } : {}),
      ...(mail.message?.trim() ? { message: mail.message.trim() } : {}),
    }, keyed(idempotencyKey)) as Promise<{ status: "queued" | "sent" | "failed" }>,
  );
  return result.ok ? { ok: true, status: result.value.status } : result;
}

/** Acceso: replaces the record's access rules (admin, step-up). */
export async function setRecordAccessAction(
  entity: string,
  id: string,
  grants: { roleId?: string; userId?: string; rights: string[] }[],
  stepUpToken?: string,
): Promise<Outcome> {
  if (!ENTITY.test(entity) || !UUID.test(id) || !Array.isArray(grants)) return { ok: false, code: "invalid_input", messages: [] };
  const result = await perform(stepUpToken, (caller) => runProcess(processDeps(), caller, "kernel.record_access.set", { entity, recordId: id, grants }));
  return result.ok ? { ok: true } : result;
}
