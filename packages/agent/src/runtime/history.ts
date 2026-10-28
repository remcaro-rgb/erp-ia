import type { UIMessage } from "ai";
import type { Sql } from "postgres";
import type { JwtClaims } from "@erp/kernel";
import { scrubTokens } from "../tools/cap";
import type { MessageRole } from "./conversation";

// A stored conversation as the drawer draws it (design §7.1, rule 17). The conversation keeps the user's text and each
// turn's model messages; the screen wants UI messages (the parts the live stream builds) and the state of every
// confirmation card, so a reloaded conversation shows pending cards still confirmable and decided ones as they ended.
// Read by the conversation's own user in the active company only.

/** Rows shown at most (the newest ones). */
export const HISTORY_VIEW_ROWS = 100;

export interface StoredMessageRow {
  id: string;
  role: MessageRole;
  parts: unknown[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The value a tool result's `output` carries (`{ type: 'json' | 'text' | 'error-*', value }`). */
function outputOf(output: unknown): { value: unknown; error: boolean } {
  if (!isRecord(output) || typeof output.type !== "string") return { value: output, error: false };
  return { value: output.value, error: output.type.startsWith("error") };
}

/** UI messages from stored rows, oldest first. Events (decided cards) are told to the model, not shown. */
export function uiMessagesFromRows(rows: readonly StoredMessageRow[]): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      const parts = row.parts.filter(isRecord).flatMap((p) => (p.type === "text" && typeof p.text === "string" ? [{ type: "text" as const, text: p.text }] : []));
      if (parts.length > 0) messages.push({ id: row.id, role: "user", parts });
    } else if (row.role === "assistant") {
      const parts: UIMessage["parts"] = [];
      const toolParts = new Map<string, Json>();
      for (const model of row.parts.filter(isRecord)) {
        if (model.role === "assistant") {
          const content = typeof model.content === "string" ? [{ type: "text", text: model.content }] : Array.isArray(model.content) ? model.content.filter(isRecord) : [];
          for (const part of content) {
            if (part.type === "text" && typeof part.text === "string" && part.text !== "") parts.push({ type: "text", text: part.text });
            else if (part.type === "tool-call" && typeof part.toolCallId === "string" && typeof part.toolName === "string") {
              const tool: Json = { type: `tool-${part.toolName}`, toolCallId: part.toolCallId, state: "input-available", input: part.input ?? {} };
              toolParts.set(part.toolCallId, tool);
              parts.push(tool as unknown as UIMessage["parts"][number]);
            }
          }
        } else if (model.role === "tool" && Array.isArray(model.content)) {
          for (const result of model.content.filter(isRecord)) {
            const tool = typeof result.toolCallId === "string" ? toolParts.get(result.toolCallId) : undefined;
            if (!tool) continue;
            const { value, error } = outputOf(result.output);
            if (error) {
              tool.state = "output-error";
              tool.errorText = typeof value === "string" ? value : "error";
            } else {
              tool.state = "output-available";
              tool.output = scrubTokens(value);
            }
          }
        }
      }
      if (parts.length > 0) messages.push({ id: row.id, role: "assistant", parts });
    }
  }
  return messages;
}

export interface CardView {
  status: "pending" | "executed" | "rejected";
  /** Why a card ended rejected without the user rejecting it (`confirmation_expired`). */
  reason?: string;
}

export interface ConversationView {
  conversationId: string;
  messages: UIMessage[];
  cards: Record<string, CardView>;
}

interface CardRow {
  id: string;
  status: "pending" | "confirmed" | "rejected" | "executed";
  result: unknown;
  expired: boolean;
}

/**
 * The conversation `conversationId` of the caller in the active company, or their latest one when no id is named; null
 * when there is none (or the named one is not theirs). A card nobody decided in time reads as rejected by expiry.
 */
export async function loadConversationView(sql: Sql, claims: JwtClaims, conversationId?: string): Promise<ConversationView | null> {
  const [conversation] = await sql<{ id: string }[]>`
    select id from kernel.agent_conversations
    where user_id = ${claims.sub} and company_id = ${claims.active_company_id}
      and (${conversationId ?? null}::uuid is null or id = ${conversationId ?? null}::uuid)
    order by updated_at desc, id desc
    limit 1`;
  if (!conversation) return null;

  const rows = await sql<StoredMessageRow[]>`
    select id, role, parts from (
      select id, role, parts, created_at from kernel.agent_messages
      where conversation_id = ${conversation.id}
      order by created_at desc, id desc
      limit ${HISTORY_VIEW_ROWS}
    ) recent
    order by created_at, id`;
  const cardRows = await sql<CardRow[]>`
    select id, status, result, expires_at <= now() as expired from kernel.agent_confirmations
    where conversation_id = ${conversation.id} and user_id = ${claims.sub}`;

  const cards: Record<string, CardView> = {};
  for (const card of cardRows) {
    if (card.status === "executed") cards[card.id] = { status: "executed" };
    else if (card.status === "rejected") {
      const reason = isRecord(card.result) && typeof card.result.reason === "string" ? card.result.reason : undefined;
      cards[card.id] = reason ? { status: "rejected", reason } : { status: "rejected" };
    } else cards[card.id] = card.expired ? { status: "rejected", reason: "confirmation_expired" } : { status: "pending" };
  }
  return { conversationId: conversation.id, messages: uiMessagesFromRows(rows), cards };
}
