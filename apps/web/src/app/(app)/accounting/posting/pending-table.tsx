"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Pill } from "@erp/ui";
import type { FailureRow } from "@/lib/accounting/posting";
import { dismissFailureAction, retryFailureAction } from "@/lib/accounting/posting-actions";
import { AdminDialog } from "../../admin/_components/admin-dialog";
import { useAdminAction } from "../../admin/_components/use-admin-action";
import { ReopenPeriodDialog } from "../periods/periods-screen";

/** Pendientes de contabilizar: the events no rule could post, each with the reason and the way out (Reintentar, Reabrir período, Descartar). */
export function PendingTable({ failures, can, today }: { failures: FailureRow[]; can: { retry: boolean; dismiss: boolean; reopenPeriod: boolean }; today: string }) {
  const t = useTranslations("common.acc_pages.posting");
  const tv = useTranslations("grid.values");
  const { execute, status, busy } = useAdminAction();
  const [answer, setAnswer] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<FailureRow | null>(null);
  const [reopening, setReopening] = useState<FailureRow | null>(null);

  const retry = async (failure: FailureRow) => {
    setAnswer(null);
    const result = await execute(() => retryFailureAction(failure.id));
    if (result.ok) setAnswer(result.resolved ? t("retry_resolved", { number: result.number ?? "" }) : t("retry_still", { reason: result.detail ?? result.code ?? "" }));
  };

  if (failures.length === 0) return <p className="erp-muted">{t("pending_none")}</p>;
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("tab.pending")}</h2>
        <span className="erp-small erp-muted">{t("pending_hint")}</span>
      </div>
      <div className="erp-admin__scroll">
        <table aria-label={t("tab.pending")}>
          <thead>
            <tr>
              <th>{t("col_event")}</th>
              <th>{t("col_date")}</th>
              <th>{t("col_rule")}</th>
              <th>{t("col_error")}</th>
              <th className="erp-num">{t("col_attempts")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {failures.map((f) => (
              <tr key={f.id}>
                <td className="erp-mono">{f.event}</td>
                <td>{(f.eventDate ?? f.createdAt).slice(0, 10).split("-").reverse().join("/")}</td>
                <td>{f.ruleName ?? "—"}</td>
                <td style={{ whiteSpace: "normal" }}>
                  <Pill tone="warn">{tv.has(`failure_code.${f.code}`) ? tv(`failure_code.${f.code}`) : f.code}</Pill> <span className="erp-small">{f.detail}</span>
                </td>
                <td className="erp-num">{f.attempts}</td>
                <td>
                  <span className="erp-row">
                    {can.retry && (
                      <button type="button" className="erp-btn erp-btn--sm" disabled={busy} onClick={() => void retry(f)}>
                        {t("retry")}
                      </button>
                    )}
                    {can.reopenPeriod && f.period && (
                      <button type="button" className="erp-btn erp-btn--sm" onClick={() => setReopening(f)}>
                        {t("reopen_period")}
                      </button>
                    )}
                    {can.dismiss && (
                      <button type="button" className="erp-btn erp-btn--sm" onClick={() => setDismissing(f)}>
                        {t("dismiss")}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div role="status">{answer ?? status}</div>
      {dismissing && <DismissDialog failure={dismissing} onClose={() => setDismissing(null)} />}
      {reopening?.period && <ReopenPeriodDialog period={reopening.period} today={reopening.eventDate ?? today} initialDay onClose={() => setReopening(null)} />}
    </section>
  );
}

function DismissDialog({ failure, onClose }: { failure: FailureRow; onClose: () => void }) {
  const t = useTranslations("common.acc_pages.posting");
  const tc = useTranslations("common");
  const { execute, status, busy } = useAdminAction();
  const [reason, setReason] = useState("");
  return (
    <AdminDialog
      open
      title={t("dismiss_title", { event: failure.event })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {tc("cancel")}
          </button>
          <button
            type="button"
            className="erp-btn erp-btn--primary"
            disabled={busy || reason.trim() === ""}
            onClick={() => void execute(() => dismissFailureAction(failure.id, reason)).then((r) => r.ok && onClose())}
          >
            {t("dismiss")}
          </button>
        </>
      }
    >
      <p>{t("dismiss_body")}</p>
      <div className="erp-field">
        <label htmlFor="dismiss-reason">{t("dismiss_reason")}</label>
        <input id="dismiss-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="erp-small erp-muted">{tc("admin.process", { process: "accounting.posting_failure.dismiss" })}</div>
      {status}
    </AdminDialog>
  );
}
