"use client";

import { useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import type { NestedFailureRow, NestedFailuresData } from "@/lib/nested/load";
import { nestedAction, type NestedActionKind } from "@/lib/nested/actions";
import { processName } from "@/lib/nested/names";
import { StepUpDock, useAdminAction } from "../admin/_components/use-admin-action";

/**
 * Fallos de ejecuciones anidadas (plan 2B Task 32, R32-7): what a nested process left in the queue when its pair says «Continuar y encolar». Shows
 * the process names, the reason, who ran it, when and the status; never the stored input (rule 14). Reintentar needs the step-up code (it replays
 * a write), Descartar keeps the row as «Descartado».
 */
export function FailuresScreen({ data }: { data: NestedFailuresData }) {
  const t = useTranslations();
  const format = useFormatter();
  const { execute, prompt, status, busy } = useAdminAction();
  const [only, setOnly] = useState(false);
  const label = (id: string) => (t.has(`process.${id}`) ? t(`process.${id}`) : processName(id, data.descriptions[id]));
  // `execute` runs the step-up flow and refreshes the server data on success.
  const act = (kind: Extract<NestedActionKind, "retry" | "dismiss">, row: NestedFailureRow) => execute((token) => nestedAction(kind, { id: row.id }, token));
  const rows = only ? data.rows.filter((r) => r.status === "pending") : data.rows;
  return (
    <div className="erp-admin">
      <section className="erp-card" aria-labelledby="nested-failures-title">
        <div className="erp-admin__head">
          <h1 id="nested-failures-title" style={{ fontSize: "1.1rem" }}>
            {t("common.nested_failures.title")}
          </h1>
          <span className="erp-small erp-muted">{t("common.nested_failures.hint")}</span>
          <span className="erp-grow" />
          <label className="erp-check">
            <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> {t("common.nested_failures.only_pending")}
          </label>
          {data.isAdmin && (
            <Link href="/admin/nested-runs" className="erp-btn erp-btn--sm">
              {t("common.nested_failures.settings_link")}
            </Link>
          )}
        </div>
        {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
        <div className="erp-admin__scroll">
          <table aria-label={t("common.nested_failures.title")}>
            <thead>
              <tr>
                <th>{t("common.nested_failures.col_parent")}</th>
                <th>{t("common.nested_failures.col_nested")}</th>
                <th>{t("common.nested_failures.col_reason")}</th>
                <th>{t("common.nested_failures.col_who")}</th>
                <th>{t("common.nested_failures.col_when")}</th>
                <th>{t("common.nested_failures.col_status")}</th>
                <th className="erp-num">{t("common.nested_failures.col_attempts")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="erp-muted" style={{ whiteSpace: "normal" }}>
                    {t("common.nested_failures.empty")}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div>{label(row.parentProcess)}</div>
                    <div className="erp-mono erp-small erp-muted">{row.parentProcess}</div>
                  </td>
                  <td>
                    <div>{label(row.nestedProcess)}</div>
                    <div className="erp-mono erp-small erp-muted">{row.nestedProcess}</div>
                  </td>
                  <td style={{ whiteSpace: "normal" }}>{row.reason}</td>
                  <td>{row.actor ?? t("common.nested_failures.unknown_actor")}</td>
                  <td>{format.dateTime(new Date(row.createdAt), { dateStyle: "medium", timeStyle: "short" })}</td>
                  <td>
                    <span className={`erp-pill erp-pill--${row.status === "pending" ? "warn" : row.status === "resolved" ? "ok" : "gray"}`}>
                      {t(`common.nested_failures.status.${row.status}`)}
                    </span>
                  </td>
                  <td className="erp-num">{row.attempts}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {row.status === "pending" && (
                      <>
                        {data.canRetry && (
                          <button type="button" className="erp-btn erp-btn--sm" disabled={busy} onClick={() => void act("retry", row)} aria-label={`${t("common.nested_failures.retry")} · ${row.nestedProcess}`}>
                            {t("common.nested_failures.retry")}
                          </button>
                        )}{" "}
                        {data.canDismiss && (
                          <button type="button" className="erp-btn erp-btn--sm" disabled={busy} onClick={() => void act("dismiss", row)} aria-label={`${t("common.nested_failures.dismiss")} · ${row.nestedProcess}`}>
                            {t("common.nested_failures.dismiss")}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.truncated && <div className="erp-small erp-muted" style={{ padding: "8px 14px" }}>{t("common.nested_failures.truncated")}</div>}
        <div className="erp-small erp-muted" style={{ padding: "8px 14px" }}>{t("common.nested_failures.retention")}</div>
        <StepUpDock prompt={prompt} />
      </section>
    </div>
  );
}
