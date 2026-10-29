"use client";

import { useLayoutEffect, useRef, useState } from "react";
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
  // Follow the bottom only while the reader is there (within 48 px): scrolling up to re-read a table or a card stops the
  // follow, and "Ir al final" brings it back. A message the user just sent always follows.
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = () => {
    const el = log.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinned.current = atEnd;
    setAway(!atEnd);
  };
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    if (messages.at(-1)?.role === "user") pinned.current = true;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      setAway(false);
    }
  }, [messages, working]);
  const jump = () => {
    const el = log.current;
    pinned.current = true;
    setAway(false);
    if (el) el.scrollTop = el.scrollHeight;
  };

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
    // aria-busy holds the announcements while a turn streams: the finished answer is read once, not token by token.
    <div ref={log} className="erp-chat__log" role="log" aria-live="polite" aria-relevant="additions" aria-busy={working ? true : false} onScroll={onScroll}>
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
      {/* Always laid out (18 px): the thinking dots before the first token, nothing after, so the log never jumps. */}
      <div className="erp-chat__status" aria-hidden="true">
        {working && !answering(messages) && (
          <span className="erp-typing">
            <i />
            <i />
            <i />
            <span>{t("agent.thinking")}</span>
          </span>
        )}
      </div>
      {away && (
        <button type="button" className="erp-btn erp-btn--sm erp-chat__jump" onClick={jump}>
          {t("agent.ui.jump_latest")} ↓
        </button>
      )}
    </div>
  );
}
