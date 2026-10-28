"use client";

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "@erp/ui/components/ui/sonner";
import { AttachmentsPanel, ExtraDataTab, extraTabCounts, recordHref, RecordFrame, type RecordTab } from "@erp/ui";
import { closeTicketAction, loadTicketAction, replyTicketAction, type ActionResult, type TicketDetail } from "@/lib/support/actions";
import { Conversation } from "./conversation";

type Phase = { kind: "loading" } | { kind: "failed"; code: string } | { kind: "ready"; ticket: TicketDetail };

const phaseOf = (result: Awaited<ReturnType<typeof loadTicketAction>>): Phase =>
  result.ok ? { kind: "ready", ticket: result.ticket } : { kind: "failed", code: result.code };

const STATUS_TONE: Record<string, string> = { open: "warn", answered: "ok", closed: "gray" };

/**
 * A ticket as the record frame shows it (design §5.16, §8), in the side sheet and in the full page
 * `/r/support.ticket/<id>`: loads the ticket as the caller, reloads after a reply or a closing.
 */
export function TicketView({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const t = useTranslations();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // First read when the sheet opens for this ticket; `reload` re-reads after a reply or a closing.
  useEffect(() => {
    let live = true;
    loadTicketAction(id).then(
      (result) => live && setPhase(phaseOf(result)),
      () => live && setPhase({ kind: "failed", code: "network" }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  const reload = useCallback(async () => {
    try {
      setPhase(phaseOf(await loadTicketAction(id)));
    } catch {
      setPhase({ kind: "failed", code: "network" });
    }
  }, [id]);

  if (phase.kind === "loading") return <p className="erp-muted erp-sheet__state">{t("common.loading")}</p>;
  if (phase.kind === "failed") {
    return (
      <div role="alert" className="erp-dian erp-dian--bad erp-sheet__state">
        {t.has(`errors.${phase.code}`) ? t(`errors.${phase.code}`) : t("common.support.ui.loading_failed")}
      </div>
    );
  }
  return (
    <TicketFrame
      ticket={phase.ticket}
      onReply={async (body, isInternal) => {
        const result = await replyTicketAction(phase.ticket.id, body, isInternal);
        if (result.ok) {
          await reload();
          onChanged?.();
        }
        return result;
      }}
      onClose={async () => {
        let result: ActionResult;
        try {
          result = await closeTicketAction(phase.ticket.id);
        } catch {
          result = { ok: false, code: "network", details: [] };
        }
        if (result.ok) {
          await reload();
          onChanged?.();
        } else {
          // The closing failed (not an agent any more, already closed…): say so, the ticket stays as it is.
          toast.error(result.details[0] ?? (t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t("errors.unknown")));
        }
      }}
    />
  );
}

function TicketFrame({ ticket, onReply, onClose }: { ticket: TicketDetail; onReply: Parameters<typeof Conversation>[0]["onReply"]; onClose: () => Promise<void> }) {
  const t = useTranslations();
  const format = useFormatter();
  const closed = ticket.status === "closed";

  const fact = (label: string, value: React.ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  const pill = (tone: string, text: string) => <span className={`erp-pill erp-pill--${tone}`}>{text}</span>;
  const context = ticket.context;
  const hasContext = context !== null && Object.keys(context).length > 0;

  const datos: Omit<RecordTab, "id"> = {
    content: (
      <div className="erp-support__data">
        <dl className="erp-support__facts">
          {ticket.kind && fact(t("field.support.ticket.kind"), t(`grid.values.ticket_kind.${ticket.kind}`))}
          {ticket.status && fact(t("field.support.ticket.status"), pill(STATUS_TONE[ticket.status] ?? "gray", t(`grid.values.ticket_status.${ticket.status}`)))}
          {ticket.priority && fact(t("field.support.ticket.priority"), t(`grid.values.ticket_priority.${ticket.priority}`))}
          {ticket.createdAt && fact(t("field.support.ticket.created_at"), format.dateTime(new Date(ticket.createdAt), { dateStyle: "medium", timeStyle: "short" }))}
        </dl>
        <section className="erp-sec">
          <h3>{t("field.support.ticket.body")}</h3>
          <p className="erp-support__body">{ticket.body ?? t("common.support.ui.hidden")}</p>
        </section>
        <section className="erp-sec">
          <h3>{t("field.support.ticket.context")}</h3>
          {!hasContext ? (
            <p className="erp-muted">{ticket.context === null ? t("common.support.ui.hidden") : t("common.support.ui.context_empty")}</p>
          ) : (
            <dl className="erp-support__facts">
              {context?.route && fact(t("common.support.ui.context_route"), <span className="erp-mono">{context.route}</span>)}
              {context?.selection && fact(t("common.support.ui.context_selection"), context.selection)}
              {context?.consoleErrors && context.consoleErrors.length > 0 && (
                fact(
                  t("common.support.ui.context_errors"),
                  <ul className="erp-support__errors erp-mono">
                    {context.consoleErrors.map((message, i) => (
                      <li key={i}>{message}</li>
                    ))}
                  </ul>,
                )
              )}
              {context?.lastAuditIds && context.lastAuditIds.length > 0 && fact(t("common.support.ui.context_audit"), <span className="erp-mono">{context.lastAuditIds.join(", ")}</span>)}
            </dl>
          )}
        </section>
      </div>
    ),
  };

  const counts = extraTabCounts(ticket.defs, ticket.extra, ticket.extraFree);
  const tabs: RecordTab[] = [
    { id: "datos", ...datos },
    {
      id: "mensajes",
      count: ticket.messages.length,
      content: <Conversation ticket={ticket} onReply={onReply} />,
    },
    { id: "extra", ...counts, content: <ExtraDataTab defs={ticket.defs} extra={ticket.extra} extraFree={ticket.extraFree} readOnly /> },
    { id: "archivos", content: <AttachmentsPanel entity="support.ticket" recordId={ticket.id} readOnly={!ticket.canReply || closed} /> },
  ];

  return (
    <RecordFrame
      className="erp-support__frame"
      title={ticket.title ?? t("entity.support.ticket")}
      seq={ticket.seq}
      uuid={ticket.id}
      deepLinkHref={recordHref("support.ticket", ticket.id)}
      tabs={tabs}
      labels={{
        tabs: {
          datos: t("common.record.tabs.datos"),
          contactos: t("common.record.tabs.contactos"),
          fotos: t("common.record.tabs.fotos"),
          mensajes: t("common.record.tabs.mensajes"),
          extra: t("common.record.tabs.extra"),
          archivos: t("common.record.tabs.archivos"),
        },
        number: t("common.record.number"),
        uuid: t("common.record.uuid"),
        assignedOnCreate: t("common.record.assigned_on_create"),
        openInNewTab: t("common.record.open_in_new_tab"),
        pending: t("common.record.pending"),
      }}
      status={ticket.status ? pill(STATUS_TONE[ticket.status] ?? "gray", t(`grid.values.ticket_status.${ticket.status}`)) : undefined}
      footer={
        ticket.canClose && !closed ? (
          <button type="button" className="erp-btn" onClick={() => void onClose()}>
            {t("common.support.ui.close_ticket")}
          </button>
        ) : undefined
      }
    />
  );
}
