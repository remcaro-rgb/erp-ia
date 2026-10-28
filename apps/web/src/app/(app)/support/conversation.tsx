"use client";

import { useId, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import type { ActionResult, TicketDetail } from "@/lib/support/actions";

export interface ConversationProps {
  ticket: TicketDetail;
  onReply: (body: string, isInternal: boolean) => Promise<ActionResult>;
}

/** The "Mensajes" tab: who said what and when, internal notes marked, and the reply box while the ticket is open. */
export function Conversation({ ticket, onReply }: ConversationProps) {
  const t = useTranslations();
  const format = useFormatter();
  const base = useId();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const closed = ticket.status === "closed";

  const author = (authorUserId: string) =>
    authorUserId === ticket.viewerId ? t("common.support.ui.author_you") : authorUserId === ticket.reporterUserId ? t("common.support.ui.author_reporter") : t("common.support.ui.author_agent");

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const result = await onReply(body, internal);
      if (result.ok) {
        setBody("");
        setInternal(false);
      } else {
        setProblem(result.details.length > 0 ? result.details.join(" · ") : t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t("errors.unknown"));
      }
    } catch {
      setProblem(t("errors.network"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="erp-support__convo">
      {ticket.messages.length === 0 ? (
        <p className="erp-muted">{t("common.support.ui.messages_empty")}</p>
      ) : (
        <ol className="erp-support__messages" aria-label={t("common.record.tabs.mensajes")}>
          {ticket.messages.map((message) => (
            <li key={message.id} className={message.isInternal ? "erp-support__message erp-support__message--note" : "erp-support__message"} data-internal={message.isInternal}>
              <div className="erp-support__who">
                <strong>{author(message.authorUserId)}</strong>
                <span className="erp-muted erp-small">{format.dateTime(new Date(message.createdAt), { dateStyle: "medium", timeStyle: "short" })}</span>
                {message.isInternal && <span className="erp-pill erp-pill--warn">{t("common.support.ui.internal_badge")}</span>}
              </div>
              <p className="erp-support__body">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
      {closed ? (
        <p className="erp-dian erp-dian--info">{t("common.support.ui.closed_notice")}</p>
      ) : ticket.canReply ? (
        <form onSubmit={send} className="erp-support__reply">
          <div className="erp-field">
            <label htmlFor={`${base}-reply`}>{t("common.support.ui.reply")}</label>
            <textarea id={`${base}-reply`} rows={3} value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} />
          </div>
          {ticket.canClose && (
            <label className="erp-row">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
              {t("common.support.ui.reply_internal")}
            </label>
          )}
          {problem && (
            <div role="alert" className="erp-dian erp-dian--bad">
              {problem}
            </div>
          )}
          <div>
            <button type="submit" className="erp-btn erp-btn--primary" disabled={busy || body.trim() === ""}>
              {t("common.support.ui.reply_send")}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
