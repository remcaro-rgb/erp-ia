"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { ConfirmationCard } from "./ConfirmationCard";
import { ResultTable } from "./ResultTable";
import { RichText } from "./RichText";
import { asConfirmation, asDirective, asQueryResult, gridStateOfQuery, processIdOfToolName, type CardState, type ResultColumn } from "./model";
import type { GridStateInput } from "../grid/types";

export interface MessageListProps {
  messages: UIMessage[];
  /** The state of each card by id; a card not listed is pending. */
  cards: Record<string, CardState>;
  onDecide: (cardId: string, decision: "confirm" | "reject", stepUpToken?: string) => void | Promise<void>;
  onEdit: (cardId: string, text: string) => void | Promise<void>;
  /** Opens a route of the app (links in the text, navigation results). */
  onNavigate: (href: string) => void;
  onOpenGrid?: (entity: string, state: GridStateInput) => void;
  /** Whether the entity has a grid screen to open a result in. */
  canOpenGrid?: (entity: string) => boolean;
  columnsOf?: (entity: string) => ResultColumn[] | undefined;
  /** The assistant is answering. */
  working?: boolean;
  timeZone?: string;
  fetcher?: typeof fetch;
}

const QUERY_TOOL = "kernel__data__query";

/** True when the last message already shows something of the answer. */
function answering(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  return last.parts.some((p) => (p.type === "text" && p.text.trim() !== "") || isToolUIPart(p));
}

/**
 * The conversation (prototype v5 `.a-log`): the user's words as text, the assistant's as markdown-lite, and each tool
 * result drawn from its structured data: a confirmation card, a result table, a link to the screen it opened.
 */
export function MessageList({ messages, cards, onDecide, onEdit, onNavigate, onOpenGrid, canOpenGrid, columnsOf, working, timeZone, fetcher }: MessageListProps) {
  const t = useTranslations();
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, working]);

  const tool = (part: UIMessage["parts"][number], key: string) => {
    if (!isToolUIPart(part)) return null;
    const name = getToolName(part);
    if (part.state === "input-streaming" || part.state === "input-available") {
      return (
        <div key={key} className="erp-chat__tool">
          {t("agent.ui.tool_running")}
        </div>
      );
    }
    if (part.state !== "output-available") return null;

    const card = asConfirmation(part.output);
    if (card) {
      return (
        <ConfirmationCard
          key={key}
          processId={processIdOfToolName(name)}
          preview={card.preview}
          state={cards[card.cardId] ?? { status: "pending" }}
          onDecide={(decision, token) => onDecide(card.cardId, decision, token)}
          onEdit={(text) => onEdit(card.cardId, text)}
          {...(fetcher ? { fetcher } : {})}
        />
      );
    }
    if (name === QUERY_TOOL) {
      const result = asQueryResult(part.output);
      const input = part.input as { entity?: unknown } | undefined;
      const entity = result?.entity ?? (typeof input?.entity === "string" ? input.entity : undefined);
      if (result && entity) {
        const columns = result.columns ?? columnsOf?.(entity);
        return (
          <ResultTable
            key={key}
            entity={entity}
            rows={result.rows}
            state={gridStateOfQuery(part.input)}
            truncated={result.truncated}
            {...(result.total !== undefined ? { total: result.total } : {})}
            {...(columns ? { columns } : {})}
            {...(onOpenGrid && canOpenGrid?.(entity) ? { onOpenGrid } : {})}
            {...(timeZone ? { timeZone } : {})}
            {...(fetcher ? { fetcher } : {})}
          />
        );
      }
    }
    const directive = asDirective(part.output);
    if (directive) {
      return (
        <a
          key={key}
          href={directive.href}
          className="erp-btn erp-btn--sm"
          onClick={(event) => {
            event.preventDefault();
            onNavigate(directive.href);
          }}
        >
          {t("agent.ui.open_link")} · {directive.href}
        </a>
      );
    }
    // Anything else (a refusal, a consult the model summarised) is not drawn: the model explains it, and its payload is data.
    return null;
  };

  return (
    <div ref={log} className="erp-chat__log" role="log" aria-live="polite">
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="erp-msg erp-msg--user">
            {message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
          </div>
        ) : message.role === "assistant" ? (
          <div key={message.id} className="erp-msg erp-msg--assistant">
            {message.parts.map((part, i) => (part.type === "text" ? <RichText key={i} text={part.text} onNavigate={onNavigate} /> : tool(part, `${message.id}:${i}`)))}
          </div>
        ) : null,
      )}
      {working && !answering(messages) && (
        <div className="erp-typing" role="status">
          <i />
          <i />
          <i />
          <span>{t("agent.thinking")}</span>
        </div>
      )}
    </div>
  );
}
