"use server";

import { ProcessError, runnableProcesses, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";
import { TICKET_CLOSE, TICKET_CREATE, TICKET_REPLY } from "./load";

// The support screen's reads and writes (rule 1): every one is a registered process run as the session's user, so
// the ownership policy, field masking and permissions apply exactly as for the assistant.

export type ActionResult = { ok: true; id: string } | { ok: false; code: string; details: string[] };

export interface TicketMessageView {
  id: string;
  seq: number;
  authorUserId: string;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export interface TicketDetail {
  id: string;
  seq: number | null;
  kind: string | null;
  title: string | null;
  body: string | null;
  status: string | null;
  priority: string | null;
  reporterUserId: string | null;
  createdAt: string | null;
  /** Null when the caller's role may not read it. */
  context: { route?: string; selection?: string; lastAuditIds?: string[]; consoleErrors?: string[] } | null;
  extra: Record<string, unknown>;
  extraFree: { name: string; value: string }[];
  defs: Awaited<ReturnType<typeof customFieldDefs>>;
  messages: TicketMessageView[];
  viewerId: string;
  canReply: boolean;
  canClose: boolean;
  /** "Duplicar" (rule 37): the caller may open a ticket, so they may file a copy of this one. */
  canCreate: boolean;
}

export type DetailResult = { ok: true; ticket: TicketDetail } | { ok: false; code: string };

const refusal = (error: unknown): ActionResult | null =>
  error instanceof ProcessError ? { ok: false, code: error.code, details: Array.isArray(error.details) ? error.details.map((d) => (typeof d === "string" ? d : ((d as { message?: unknown })?.message ?? "")).toString()) : [] } : null;

async function run(processId: string, input: unknown, sourceRowId?: string): Promise<ActionResult> {
  const caller = await requireCaller();
  try {
    // A copy names its source ("Duplicar", rule 37) once the caller has read it: a ticket they cannot see is refused.
    if (sourceRowId) await runProcess(processDeps(), caller, "support.ticket.consult", { id: sourceRowId });
    const out = (await runProcess(processDeps(), caller, processId, input, sourceRowId ? { sourceRowId } : {})) as { id: string };
    return { ok: true, id: out.id };
  } catch (error) {
    await signOutIfDisabled(error);
    const known = refusal(error);
    if (known) return known;
    throw error;
  }
}

const customFieldDefs = (caller: Awaited<ReturnType<typeof requireCaller>>) => runProcess(processDeps(), caller, "kernel.custom_field.list", { entity: "support.ticket" });

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** A ticket with its conversation, as the caller may see it; `not_found` for a ticket that is not theirs. */
export async function loadTicketAction(id: string): Promise<DetailResult> {
  const caller = await requireCaller();
  const deps = processDeps();
  try {
    const [row, runnable, defs] = await Promise.all([
      runProcess(deps, caller, "support.ticket.consult", { id }) as Promise<Record<string, unknown> & { messages: Record<string, unknown>[] }>,
      runnableProcesses(deps.sql, deps.registry, caller.claims, [TICKET_REPLY, TICKET_CLOSE, TICKET_CREATE]),
      customFieldDefs(caller).catch((error: unknown) => {
        // A role that may not list custom fields sees the tab without them.
        if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return [];
        throw error;
      }),
    ]);
    const context = row.context && typeof row.context === "object" ? (row.context as TicketDetail["context"]) : null;
    return {
      ok: true,
      ticket: {
        id,
        seq: count(row.seq),
        kind: text(row.kind),
        title: text(row.title),
        body: text(row.body),
        status: text(row.status),
        priority: text(row.priority),
        reporterUserId: text(row.reporter_user_id),
        createdAt: iso(row.created_at),
        context,
        extra: (row.extra as Record<string, unknown> | null) ?? {},
        extraFree: (row.extra_free as { name: string; value: string }[] | null) ?? [],
        defs,
        messages: row.messages.map((m) => ({
          id: String(m.id),
          seq: Number(m.seq),
          authorUserId: String(m.author_user_id ?? ""),
          body: String(m.body ?? ""),
          isInternal: m.is_internal === true,
          createdAt: iso(m.created_at) ?? "",
        })),
        viewerId: caller.claims.sub,
        canReply: runnable.has(TICKET_REPLY),
        canClose: runnable.has(TICKET_CLOSE),
        canCreate: runnable.has(TICKET_CREATE),
      },
    };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code };
    throw error;
  }
}

/** Files a ticket; `sourceRowId` names the ticket it was copied from ("Duplicar"), which the audit records. */
export async function createTicketAction(input: { kind: string; title: string; body: string; context?: unknown }, options?: { sourceRowId?: string }): Promise<ActionResult> {
  return run(TICKET_CREATE, input, typeof options?.sourceRowId === "string" ? options.sourceRowId : undefined);
}

export async function replyTicketAction(ticketId: string, body: string, isInternal: boolean): Promise<ActionResult> {
  return run("support.ticket.reply", { ticketId, body, isInternal });
}

export async function closeTicketAction(id: string): Promise<ActionResult> {
  return run("support.ticket.close", { id });
}
