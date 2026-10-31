"use server";

import { getTranslations } from "next-intl/server";
import { ProcessError, runnableProcesses, runProcess, withClaims } from "@erp/kernel";
import type { ActionOutcome, Chosen, EntryAction, LookupKind } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import { processDeps } from "@/lib/server/runtime";

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
        // Only accounts the viewer may post to (§5.13): the lookup never offers one the posting would refuse.
        rows = await tx<Found>`
          select id, code, name from accounting.v_accounts
          where is_active and allows_movement and accounting.can_post_account(id) and (${all} or code like ${prefix} or name ilike ${inside})
          order by code limit 10`;
        break;
      case "party":
        rows = await tx<Found>`
          select id, document_number as code, coalesce(legal_name, trade_name) as name from core.v_parties
          where coalesce(is_active, true) and (${all} or document_number like ${prefix} or legal_name ilike ${inside} or trade_name ilike ${inside})
          order by legal_name nulls last limit 10`;
        break;
      case "costCenter":
        rows = await tx<Found>`select id, code, name from accounting.v_cost_centers where is_active and kind = 'leaf' and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
      case "openAuxiliary":
        rows = await tx<Found>`select id, code, name from accounting.v_open_auxiliaries where is_active and kind = 'leaf' and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
      case "item":
        rows = await tx<Found>`select id, code, name from accounting.v_items where is_active and kind = 'leaf' and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
      case "businessUnit":
        rows = await tx<Found>`select id, code, name from accounting.v_business_units where is_active and kind = 'leaf' and (${all} or code like ${prefix} or name ilike ${inside}) order by code limit 10`;
        break;
    }
    return rows.map((r) => ({ id: r.id, label: [r.code, r.name].filter(Boolean).join(" · ") }));
  });
}

const PROCESS: Record<EntryAction, string> = {
  submit: "accounting.entry.submit",
  approve: "accounting.entry.post",
  post: "accounting.entry.post",
  return: "accounting.entry.return_to_draft",
  void: "accounting.entry.void",
  reverse: "accounting.entry.reverse",
};

/** Runs a status button of the comprobante. A step-up token answers a `step_up_required`. */
export async function runEntryAction(action: EntryAction, id: string, input: { reason?: string }, stepUpToken?: string): Promise<ActionOutcome> {
  if (!(action in PROCESS)) return { ok: false, code: "invalid_input", messages: [] };
  if (typeof id !== "string") return { ok: false, code: "invalid_input", messages: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  const deps = processDeps();
  const t = await getTranslations("common.entry");
  try {
    const reason = input.reason?.trim();
    const processInput = action === "void" || action === "reverse" ? { id, reason: reason ?? "" } : action === "return" ? { id, ...(reason ? { reason } : {}) } : { id };
    const result = (await runProcess(deps, caller, PROCESS[action], processInput)) as { number?: string };
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
}
export interface TemplateLine {
  lineNo: number;
  account: string;
  side: "debit" | "credit";
  /** The template's fixed amount; null when the line asks for one. */
  amount: number | null;
}

/** The plantillas the viewer may use, by name. */
export async function listTemplatesAction(): Promise<TemplateOption[]> {
  const caller = await requireCaller();
  const deps = processDeps();
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["accounting.entry.from_template"]);
  if (!runnable.has("accounting.entry.from_template")) return [];
  return withClaims(deps.sql, caller.claims, (tx) => tx<TemplateOption[]>`select id, name from accounting.v_entry_templates order by name limit 100`);
}

/** The lines of a plantilla, to ask for the values it leaves open. */
export async function templateLinesAction(templateId: string): Promise<TemplateLine[]> {
  const caller = await requireCaller();
  try {
    const template = (await runProcess(processDeps(), caller, "accounting.entry_template.consult", { id: templateId })) as { lines?: Record<string, unknown>[] };
    return (template.lines ?? []).map((l) => ({
      lineNo: Number(l.line_no),
      account: [l.account_code, l.account_name].filter(Boolean).join(" · "),
      side: l.side === "credit" ? "credit" : "debit",
      amount: l.amount === null || l.amount === undefined ? null : Number(l.amount),
    }));
  } catch (error) {
    if (error instanceof ProcessError) return [];
    throw error;
  }
}

export type FromTemplateResult = { ok: true; id: string } | { ok: false; code: string; messages: string[] };

/** Creates a draft from a plantilla (`accounting.entry.from_template`). */
export async function fromTemplateAction(input: { templateId: string; date: string; amounts: Record<string, number> }): Promise<FromTemplateResult> {
  const caller = await requireCaller();
  try {
    const { id } = (await runProcess(processDeps(), caller, "accounting.entry.from_template", input)) as { id: string };
    return { ok: true, id };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, messages: issuesOf(error.details).map((i) => i.message) };
    throw error;
  }
}
