import type { ModelMessage } from "ai";
import type { Sql } from "postgres";
import type { JwtClaims } from "@erp/kernel";

// The conversation's own rows (design §7.1: agent_conversations, agent_messages). Written with the service connection
// by the turn route and the agent workflow (rule 12); every function names the user and the company it acts for, so a
// conversation is only ever read or extended by its own user in its own company.

export type MessageRole = "user" | "assistant" | "event";

/** Turns of history the model is given (each assistant row holds a whole turn's response messages). */
export const HISTORY_ROWS = 20;

/** Creates a conversation of the caller in the active company; the title is the start of the first question. */
export async function createConversation(sql: Sql, claims: JwtClaims, firstText: string): Promise<string> {
  const title = firstText.replace(/\s+/g, " ").trim().slice(0, 80);
  const [row] = await sql<{ id: string }[]>`
    insert into kernel.agent_conversations (company_id, user_id, title, created_by)
    values (${claims.active_company_id}, ${claims.sub}, ${title}, ${claims.sub})
    returning id`;
  return row!.id;
}

/** Whether `conversationId` is the caller's, in the caller's active company. */
export async function ownsConversation(sql: Sql, claims: JwtClaims, conversationId: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from kernel.agent_conversations
      where id = ${conversationId} and user_id = ${claims.sub} and company_id = ${claims.active_company_id}
    ) as ok`;
  return row!.ok;
}

/** Appends a row; with `runId`, a retried step writes the run's row for that role once. */
export async function appendMessage(
  sql: Sql,
  row: { companyId: string; conversationId: string; role: MessageRole; parts: unknown[]; runId?: string; userId?: string },
): Promise<void> {
  await sql`
    insert into kernel.agent_messages (company_id, conversation_id, role, parts, run_id, created_by)
    values (${row.companyId}, ${row.conversationId}, ${row.role}, ${sql.json(row.parts as never)}, ${row.runId ?? null}, ${row.userId ?? null})
    on conflict do nothing`;
  await sql`update kernel.agent_conversations set updated_at = now() where id = ${row.conversationId}`;
}

interface StoredRow {
  role: MessageRole;
  parts: unknown[];
}

/** What an `event` row tells the model on the next turn: a decided confirmation card. */
function eventText(parts: unknown[]): string {
  const lines = parts.map((part) => {
    const p = part as { type?: string; processId?: string; status?: string; result?: unknown; error?: string };
    if (p.type !== "confirmation") return JSON.stringify(part);
    const outcome = p.status === "executed" ? `se ejecutó; resultado: ${JSON.stringify(p.result ?? null)}` : p.status === "rejected" ? "el usuario la descartó" : `no se ejecutó (${p.error ?? p.status})`;
    return `[Confirmación de ${p.processId}] ${outcome}`;
  });
  return lines.join("\n");
}

/** Model messages from stored rows, oldest first: user text, the assistant's stored response messages, events. */
export function toModelMessages(rows: StoredRow[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const row of rows) {
    if (row.role === "assistant") out.push(...(row.parts as ModelMessage[]));
    else if (row.role === "user") {
      const text = row.parts.map((p) => (p as { text?: string }).text ?? "").join("\n");
      out.push({ role: "user", content: text });
    } else out.push({ role: "user", content: eventText(row.parts) });
  }
  return out;
}

/** The last `HISTORY_ROWS` rows of the conversation as model messages, excluding the current run's rows. */
export async function loadHistory(sql: Sql, conversationId: string, excludeRunId?: string): Promise<ModelMessage[]> {
  const rows = await sql<StoredRow[]>`
    select role, parts from (
      select role, parts, created_at, id from kernel.agent_messages
      where conversation_id = ${conversationId} and (run_id is null or run_id <> ${excludeRunId ?? ""})
      order by created_at desc, id desc
      limit ${HISTORY_ROWS}
    ) recent
    order by created_at, id`;
  // Cut at a turn boundary: the history the model reads starts with something the user said.
  const first = rows.findIndex((r) => r.role !== "assistant");
  return toModelMessages(first < 0 ? [] : rows.slice(first));
}
