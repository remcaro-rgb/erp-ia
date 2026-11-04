"use server";

import { getTranslations } from "next-intl/server";
import { ProcessError, runnableProcesses, runProcess, withClaims } from "@erp/kernel";
import type { Chosen, EntryAction, LookupKind, RecordActionOutcome as ActionOutcome } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import { processDeps } from "@/lib/server/runtime";
import { templateLinesOf } from "./entry-template";

// What the comprobante record asks of the server (accounting design §8): the lookups of the lines editor, the status buttons and the
// "Nuevo desde plantilla" dialog. Every write is a registered process run as the session's user (rule 1).

const KINDS: readonly LookupKind[] = ["account", "party", "costCenter", "openAuxiliary", "item", "businessUnit"];

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

type Found = { id: string; code: string | null; name: string | null }[];

/** Records of one kind matching the text, as the viewer may see them (RLS and masks apply through the published views). */
export async function lookupLineAction(kind: LookupKind, search: string): Promise<Chosen[]> {
  if (!KINDS.includes(kind) || typeof search !== "string") return [];
  const caller = await requireCaller();
  const deps = processDeps();
  // Only who works on comprobantes searches for their lines.
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["accounting.entry.create", "accounting.entry.update"]);
  if (runnable.size === 0) return [];
  const text = escapeLike(search.trim().slice(0, 80));
  const all = text === "";
  const prefix = `${text}%`;
  const inside = `%${text}%`;
  return withClaims(deps.sql, caller.claims, async (tx): Promise<Chosen[]> => {
    let rows: Found;
    switch (kind) {
      case "account":
        // Only accounts the viewer may post to (§5.13), and every maestro only when usable (spec §5.2, D10: not Pendiente or No
        // Aprobado): the lookup never offers one the posting would refuse.
        rows = await tx<Found>`
          select id, code, name from accounting.v_accounts
          where is_active and allows_movement and accounting.can_post_account(id) and kernel.record_usable('accounting.account', id) and (${all} or code like ${prefix} or name ilike ${inside})
          order by code limit 10`;
        break;
      case "party":
        rows = await tx<Found>`
          select id, document_number as code, coalesce(legal_name, trade_name) as name from core.v_parties
          where coalesce(is_active, true) and kernel.record_usable('core.party', id) and (${all} or document_number like ${prefix} or legal_name ilike ${inside} or trade_name ilike ${inside})
          order by legal_name nulls last limit 10`;
        break;
      case "costCenter":
        rows = await tx<Found>`select id, code, name from accounting.v_cost_centers where is_active and kind = 'leaf' and kernel.record_usable('accounting.cost_center', id) and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
      case "openAuxiliary":
        rows = await tx<Found>`select id, code, name from accounting.v_open_auxiliaries where is_active and kind = 'leaf' and kernel.record_usable('accounting.open_auxiliary', id) and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
      case "item":
        rows = await tx<Found>`select id, code, name from accounting.v_items where is_active and kind = 'leaf' and kernel.record_usable('accounting.item', id) and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
      case "businessUnit":
        rows = await tx<Found>`select id, code, name from accounting.v_business_units where is_active and kind = 'leaf' and kernel.record_usable('accounting.business_unit', id) and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
    }
    return rows.map((r) => ({ id: r.id, label: [r.code, r.name].filter(Boolean).join(" · ") }));
  });
}

// The status buttons on the comprobante's lifecycle (entity types spec §5, Phase 2A.5 Task 8b): Grabar posts it when it needs no
// approval; with approval Enviar a aprobación is Grabar then Enviar (one click, two processes: a refusal of the second leaves it
// Grabado), Aprobar posts it, No Aprobar hands it back with the reason.
const PROCESS: Record<EntryAction, string> = {
  post: "accounting.entry.save",
  submit: "accounting.entry.submit",
  approve: "accounting.entry.approve",
  return: "accounting.entry.reject",
  void: "accounting.entry.void",
  delete: "accounting.entry.delete",
  reverse: "accounting.entry.reverse",
};
const NEEDS_REASON = new Set<EntryAction>(["void", "reverse", "return"]);

/** Runs a status button of the comprobante. A step-up token answers a `step_up_required`. */
export async function runEntryAction(action: EntryAction, id: string, input: { reason?: string }, stepUpToken?: string, idempotencyKey?: string): Promise<ActionOutcome> {
  if (!(action in PROCESS)) return { ok: false, code: "invalid_input", messages: [] };
  if (typeof id !== "string") return { ok: false, code: "invalid_input", messages: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  const deps = processDeps();
  const t = await getTranslations("accounting.entry");
  try {
    const reason = input.reason?.trim();
    const processInput = NEEDS_REASON.has(action) ? { id, reason: reason ?? "" } : { id };
    // A Borrador or No Aprobado comprobante is Grabado before it is sent.
    if (action === "submit") {
      const { status } = (await runProcess(deps, caller, "accounting.entry.consult", { id })) as { status?: string };
      if (status === "draft" || status === "rejected") await runProcess(deps, caller, "accounting.entry.save", { id });
    }
    // The click's key (the action bar's, minor 2): a double click runs the action once.
    const keyed = typeof idempotencyKey === "string" && /^bar:[a-z][a-z0-9_.]*:[0-9a-f-]{36}$/.test(idempotencyKey) ? { idempotencyKey } : {};
    const result = (await runProcess(deps, caller, PROCESS[action], processInput, keyed)) as { number?: string };
    return { ok: true, message: t(`done.${action}`, { number: result.number ?? "" }) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, messages: issuesOf(error.details).map((i) => i.message) };
    throw error;
  }
}

export interface TemplateOption {
  id: string;
  name: string;
  note: string | null;
}

/** The plantillas the viewer may start a comprobante from: active, readable and with the `use` right, by name. */
export async function listTemplatesAction(): Promise<TemplateOption[]> {
  const caller = await requireCaller();
  const deps = processDeps();
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["accounting.entry.create"]);
  if (!runnable.has("accounting.entry.create")) return [];
  return withClaims(
    deps.sql,
    caller.claims,
    (tx) => tx<TemplateOption[]>`
      select id, name, note from accounting.v_entry_templates
      where is_active is not false and kernel.can_access_record('accounting.entry_template', id, 'use')
      order by name limit 100`,
  );
}

export type SaveTemplateResult = { ok: true; id: string } | { ok: false; code: string; messages: string[] };

/** "Guardar como plantilla": a plantilla de comprobante from a stored comprobante's header and lines (`accounting.entry_template.create`). */
export async function saveAsTemplateAction(input: { entryId: string; name: string; blankAmounts: boolean }): Promise<SaveTemplateResult> {
  const caller = await requireCaller();
  try {
    const entry = (await runProcess(processDeps(), caller, "accounting.entry.consult", { id: input.entryId })) as Record<string, unknown> & { lines?: Record<string, unknown>[] };
    const mapped = templateLinesOf(entry.lines ?? [], input.blankAmounts);
    if (!mapped.ok) return { ok: false, code: "template_lines", messages: [] };
    const { id } = (await runProcess(processDeps(), caller, "accounting.entry_template.create", {
      name: input.name,
      journalId: entry.journal_id,
      ...(typeof entry.description === "string" && entry.description !== "" ? { description: entry.description } : {}),
      ...(typeof entry.business_unit_id === "string" ? { businessUnitId: entry.business_unit_id } : {}),
      lines: mapped.lines,
    })) as { id: string };
    return { ok: true, id };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, messages: issuesOf(error.details).map((i) => i.message) };
    throw error;
  }
}
